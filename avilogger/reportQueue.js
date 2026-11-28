/*
MIT License

Copyright (c) 2026 World Balancer

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

// Sends a user-made avatar report ("Report" button) to the World Balancer
// reports API. One report at a time, with retries for temporary errors.
// Unlike avatarQueue.js (automatic log uploads), every report here is a
// deliberate click, so the answer goes straight back to the window.

const axios = require("axios");
const https = require("https");
const main = require("../main");
const { log_error } = require("../functions/logsclass.js");
const { version } = require("../package.json");
const { retryWaitMs, parseRetryAfterMs } = require("./avatarQueue.js");
const { readDiscordId } = require("./discordId.js");

const REPORT_URL = "https://avatarwbvrcxsearch.worldbalancer.com/reports";

const MAX_REASON_LENGTH = 500; // the server rejects anything longer
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 15000; // the person is waiting for the answer
const MIN_GAP_MS = 1000; // pause between two reports
const MAX_PENDING = 10; // reports waiting behind the one being sent

const AVATAR_ID_REGEX =
  /^avtr_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

// Failures where the request certainly never reached the server. Any other
// network error or a 5xx may have been committed with the answer lost.
const NOT_SENT_CODES = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"]);
const MAX_SERVER_PAUSE_MS = 10 * 60 * 1000; // ceiling for a server Retry-After

let pausedUntil = 0; // set by 429 / Retry-After: no report goes out before this

function isAmbiguousFailure(err) {
  const status = err.response?.status;
  if (status) return status >= 500 && status <= 599;
  return !NOT_SENT_CODES.has(err.code);
}

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 2,
  maxFreeSockets: 1,
  scheduling: "lifo",
});

const axiosInstance = axios.create({
  timeout: 25000,
  maxRedirects: 0, // never follow redirects: the body contains the user's Discord ID
  httpsAgent,
  headers: {
    "Content-Type": "application/json",
    "User-Agent": `World Balancer/${version} contact@worldbalancer.com`,
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reportError(message) {
  log_error.writeErrorToFile(message);
}

function logToMain(message, type = "info") {
  main.log(message, type, "main_log");
}

function isRetryable(err) {
  const status = err.response?.status;
  return (
    NETWORK_ERROR_CODES.has(err.code) ||
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

// The server answers errors as { "error": "..." }. Anything else (for example
// a proxy's HTML page) is not shown to the user.
function serverMessage(err) {
  const data = err.response?.data;
  return data && typeof data === "object" && typeof data.error === "string"
    ? data.error
    : null;
}

/**
 * Checks what the window sent. The main process never trusts the window: this
 * runs again here even though the form already checked it.
 * Returns { avatarId, reason } or { error }.
 */
function validateReportInput(avatarId, reason) {
  if (typeof avatarId !== "string" || !AVATAR_ID_REGEX.test(avatarId.trim())) {
    return {
      error: "That is not a valid avatar ID (avtr_ followed by a UUID).",
    };
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return { error: "The reason must be text." };
  }
  const cleanReason = (reason || "").trim();
  if (cleanReason.length > MAX_REASON_LENGTH) {
    return {
      error: `The reason is too long (${cleanReason.length}/${MAX_REASON_LENGTH} characters).`,
    };
  }
  // Lower case, so the same avatar never gets two keys or two reports
  return { avatarId: avatarId.trim().toLowerCase(), reason: cleanReason };
}

// Turns a failed request into the message shown in the window.
function failureResult(err) {
  const status = err?.response?.status;
  let code = "error";
  let message;

  if (status === 400) {
    code = "rejected";
    message = serverMessage(err) || "The server did not accept the report.";
  } else if (status === 403) {
    code = "denied";
    message = "The server refused the report (access denied).";
  } else if (status === 429) {
    code = "busy";
    message = "The server is busy. Try again in a minute.";
  } else if (status === 408 || (status >= 500 && status <= 599)) {
    code = "server";
    message = "The report server is having problems. Try again later.";
  } else if (!err?.response && NETWORK_ERROR_CODES.has(err?.code)) {
    code = "network";
    message =
      "Could not reach the report server. Check your internet connection.";
  } else {
    message = `The report could not be sent (${err?.message || "unknown error"}).`;
  }

  logToMain(`[Report] Not sent: ${message}`, "warn");
  return { ok: false, code, message };
}

function configErrorResult() {
  return {
    ok: false,
    code: "config_error",
    message:
      "Your settings could not be read. Try again, or restart the app if it keeps happening.",
  };
}

function noDiscordIdResult() {
  return {
    ok: false,
    code: "no_discord_id",
    message:
      "Set your Discord ID in the Settings tab first (17-20 digits), then try again.",
  };
}

function buildReportBody(avatarId, discordId, reason) {
  const body = { avatar_id: avatarId, discord_id: discordId };
  if (reason) body.reason = reason;
  return body;
}

function createdResult(avatarId, reportId, note = "") {
  logToMain(
    `[Report] Sent for ${avatarId}${reportId ? ` (report #${reportId})` : ""}${note}`,
  );
  return {
    ok: true,
    code: "created",
    reportId,
    message: reportId
      ? `Report #${reportId} sent. Thank you!`
      : "Report sent. Thank you!",
  };
}

// The server already has an open report from this user for this avatar.
function conflictResult(avatarId, maybeSent) {
  logToMain(`[Report] Already reported: ${avatarId}`);
  // The server cannot tell us whether the open report came from this very
  // submission or an older one, so never claim "sent" here. After an unclear
  // failure it is likely the one we just sent: say that it is on file.
  return {
    ok: false,
    code: "duplicate",
    message: maybeSent
      ? "Your report for this avatar is already on file (it may have been received a moment ago)."
      : "You already have an open report for this avatar.",
  };
}

function logFailedAttempt(avatarId, err) {
  reportError(
    `[Report] FAILED ${avatarId} | code=${err.code} | status=${err.response?.status || "N/A"} | ${err.message}`,
  );
}

// How long to wait before the next attempt, and whether to make one at all.
// Also records a server cooldown so every later report honors it too.
function planRetry(err, attempt) {
  const serverWait = parseRetryAfterMs(err.response?.headers?.["retry-after"]);
  const wait = serverWait ?? retryWaitMs(err, attempt);

  if (err.response?.status === 429 || serverWait != null) {
    pausedUntil = Math.max(
      pausedUntil,
      Date.now() + Math.min(wait, MAX_SERVER_PAUSE_MS),
    );
  }
  const canRetry = attempt < MAX_RETRIES && wait <= MAX_RETRY_WAIT_MS;
  return { canRetry, wait };
}

async function sendReport({ avatarId, reason }) {
  let discordId;
  try {
    discordId = await readDiscordId(); // read each time: Settings may have changed
  } catch (err) {
    reportError(`[Report] Could not read Userid.discord_id: ${err.message}`);
    return configErrorResult();
  }
  if (!discordId) return noDiscordIdResult();

  const body = buildReportBody(avatarId, discordId, reason);
  let lastErr = null;
  let maybeSent = false; // an earlier attempt may have been stored by the server

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axiosInstance.post(REPORT_URL, body);
      return createdResult(avatarId, res.data?.id ?? null);
    } catch (err) {
      lastErr = err;
      if (err.response?.status === 409) {
        return conflictResult(avatarId, maybeSent);
      }
      logFailedAttempt(avatarId, err);

      // 400/403/404...: sending the same thing again won't help
      if (!isRetryable(err)) break;
      if (isAmbiguousFailure(err)) maybeSent = true;

      const { canRetry, wait } = planRetry(err, attempt);
      if (!canRetry) break;
      await sleep(wait);
    }
  }

  return failureResult(lastErr);
}

const queue = [];
const inFlight = new Map(); // avatar id -> promise of its result
let running = false;

async function runWorker() {
  if (running) return;
  running = true;

  try {
    while (queue.length > 0) {
      const pause = pausedUntil - Date.now();
      if (pause > 0) await sleep(pause);

      const job = queue.shift();
      let result;
      try {
        result = await sendReport(job);
      } catch (err) {
        reportError(`[Report] Unexpected error: ${err.message}`);
        result = {
          ok: false,
          code: "error",
          message: "Something went wrong while sending the report.",
        };
      }
      job.resolve(result);
      if (queue.length > 0) await sleep(MIN_GAP_MS);
    }
  } finally {
    running = false;
    // A job queued while the loop was ending still needs a worker
    if (queue.length > 0) runWorker();
  }
}

/**
 * Sends a report for an avatar ID. Never rejects; always resolves to
 *   { ok: true,  code: "created",  reportId, message }
 *   { ok: false, code, message }
 * where code is one of: "invalid", "no_discord_id", "config_error", "duplicate", "rejected",
 * "denied", "busy", "server", "network", "error".
 * Clicking twice on the same avatar while it is still being sent shares one
 * request and one answer.
 */
function submitReport(avatarId, reason) {
  const clean = validateReportInput(avatarId, reason);
  if (clean.error) {
    return Promise.resolve({
      ok: false,
      code: "invalid",
      message: clean.error,
    });
  }

  const existing = inFlight.get(clean.avatarId);
  if (existing) return existing;

  // The server asked for a longer cooldown than anyone should wait on screen
  const pauseLeft = pausedUntil - Date.now();
  if (pauseLeft > MAX_RETRY_WAIT_MS) {
    return Promise.resolve({
      ok: false,
      code: "busy",
      message: `The server asked us to wait. Try again in ${Math.ceil(pauseLeft / 1000)} seconds.`,
    });
  }

  if (queue.length >= MAX_PENDING) {
    return Promise.resolve({
      ok: false,
      code: "busy",
      message: "Too many reports are waiting. Try again in a moment.",
    });
  }

  const promise = new Promise((resolve) => {
    queue.push({ avatarId: clean.avatarId, reason: clean.reason, resolve });
  });
  inFlight.set(clean.avatarId, promise);
  promise.then(() => inFlight.delete(clean.avatarId));

  runWorker();
  return promise;
}

/**
 * Resolves when no report is queued or being sent, or after timeoutMs.
 * Used before quitting so a report the person just sent is not cut off.
 */
async function waitForIdle(timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while ((running || queue.length > 0) && Date.now() < deadline) {
    await sleep(100);
  }
}

module.exports = { submitReport, validateReportInput, waitForIdle };
