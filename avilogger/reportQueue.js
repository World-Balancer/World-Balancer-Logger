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
const getConfig = require("../models/getConfig");
const { log_error } = require("../functions/logsclass.js");
const { version } = require("../package.json");
const { normalizeDiscordId, retryWaitMs } = require("./avatarQueue.js");

// WB_REPORT_URL is only meant for testing against a local server.
const REPORT_URL =
  process.env.WB_REPORT_URL ||
  "https://avatarwbvrcxsearch.worldbalancer.com/reports";

const MAX_REASON_LENGTH = 500; // the server rejects anything longer
const MAX_RETRIES = 2;
const MAX_RETRY_WAIT_MS = 15000; // the person is waiting for the answer
const MIN_GAP_MS = 1000; // pause between two reports
const MAX_PENDING = 10; // reports waiting behind the one being sent

const AVATAR_ID_REGEX =
  /^avtr_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISCORD_ID_REGEX = /^\d{17,20}$/;

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

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
    return { error: "That is not a valid avatar ID (avtr_ followed by a UUID)." };
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
  return { avatarId: avatarId.trim(), reason: cleanReason };
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
  } else if (status >= 500 && status <= 599) {
    code = "server";
    message = "The report server is having problems. Try again later.";
  } else if (!err?.response && NETWORK_ERROR_CODES.has(err?.code)) {
    code = "network";
    message = "Could not reach the report server. Check your internet connection.";
  } else {
    message = `The report could not be sent (${err?.message || "unknown error"}).`;
  }

  logToMain(`[Report] Not sent: ${message}`, "warn");
  return { ok: false, code, message };
}

async function sendReport({ avatarId, reason }) {
  // Read each time: the user may have changed it in Settings meanwhile
  let discordId = null;
  try {
    discordId = normalizeDiscordId(await getConfig("Userid.discord_id"));
  } catch (err) {
    reportError(`[Report] Could not read Userid.discord_id: ${err.message}`);
  }
  if (!discordId || !DISCORD_ID_REGEX.test(discordId)) {
    return {
      ok: false,
      code: "no_discord_id",
      message:
        "Set your Discord ID in the Settings tab first (17-20 digits), then try again.",
    };
  }

  const body = { avatar_id: avatarId, discord_id: discordId };
  if (reason) body.reason = reason;

  let lastErr = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await axiosInstance.post(REPORT_URL, body);
      const reportId = res.data?.id ?? null;
      logToMain(
        `[Report] Sent for ${avatarId}${reportId ? ` (report #${reportId})` : ""}`,
      );
      return {
        ok: true,
        code: "created",
        reportId,
        message: reportId
          ? `Report #${reportId} sent. Thank you!`
          : "Report sent. Thank you!",
      };
    } catch (err) {
      lastErr = err;

      // The server already has an open report from this user for this avatar
      if (err.response?.status === 409) {
        logToMain(`[Report] Already reported: ${avatarId}`);
        return {
          ok: false,
          code: "duplicate",
          message: "You already have an open report for this avatar.",
        };
      }

      reportError(
        `[Report] FAILED ${avatarId} | code=${err.code} | status=${err.response?.status || "N/A"} | ${err.message}`,
      );

      // 400/403/404...: sending the same thing again won't help
      if (!isRetryable(err) || attempt === MAX_RETRIES) break;

      await sleep(Math.min(retryWaitMs(err, attempt), MAX_RETRY_WAIT_MS));
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
 * where code is one of: "invalid", "no_discord_id", "duplicate", "rejected",
 * "denied", "busy", "server", "network", "error".
 * Clicking twice on the same avatar while it is still being sent shares one
 * request and one answer.
 */
function submitReport(avatarId, reason) {
  const clean = validateReportInput(avatarId, reason);
  if (clean.error) {
    return Promise.resolve({ ok: false, code: "invalid", message: clean.error });
  }

  const existing = inFlight.get(clean.avatarId);
  if (existing) return existing;

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

module.exports = { submitReport, validateReportInput };
