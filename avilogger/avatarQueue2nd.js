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

const axios = require("axios");
const http = require("http");
const https = require("https");
const main = require("../main");
const getConfig = require("../models/getConfig.js");
const { log_error } = require("../functions/logsclass.js");
const { version } = require("../package.json");

// "lifo": reuse the most recently used idle connection first. The server (or a
// proxy in front of it) closes idle connections after a while, and reusing an
// old one is what produces "read ECONNRESET" on the first request after a
// quiet period; with lifo the old ones are left to expire instead.
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  scheduling: "lifo",
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  scheduling: "lifo",
});

const axiosInstance = axios.create({
  timeout: 25000,
  maxRedirects: 0, // never follow redirects: POST bodies contain user data
  httpAgent,
  httpsAgent,
  headers: {
    "Content-Type": "application/json",
    "User-Agent": `World Balancer/${version} contact@worldbalancer.com`,
    Connection: "keep-alive",
  },
});

function reportError(message, emitToMain = false) {
  log_error.writeErrorToFile(message);
  if (emitToMain) {
    main.log(message, "error", "main_log");
  }
}

// Config values may be stored as JSON text (e.g. "\"1234\""); keep it a string
// so large Discord IDs never get converted to a number and lose precision.
let warnedUnsafeDiscordId = false;

function normalizeDiscordId(raw) {
  if (typeof raw === "bigint") raw = raw.toString();

  // A config value stored as a JSON number. Convert it to a string ID, but
  // only when the number is exact: Discord IDs have ~18 digits, more than a
  // JavaScript number holds, so a larger value was already rounded when it was
  // parsed and its digits are wrong. A wrong ID would attribute updates to
  // another user, so those are rejected (and reported once) instead.
  if (typeof raw === "number") {
    if (Number.isSafeInteger(raw) && raw > 0) return String(raw);
    if (!warnedUnsafeDiscordId) {
      warnedUnsafeDiscordId = true;
      reportError(
        'Userid.discord_id is stored as a number that cannot hold the full ID without rounding. Store it as a string (e.g. "123456789012345678").',
      );
    }
    return null;
  }

  if (typeof raw !== "string") return null;
  let value = raw.trim();
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") value = parsed.trim();
  } catch {
    // plain string, keep as is
  }
  return value !== "" ? value : null;
}

const SWITCH_URL = "https://aswb.worldbalancer.com/v9/api/avatar-check";
const MAX_SEND_RETRIES = 2;
const RETRY_BASE_MS = 300; // 300 ms, then 600 ms

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Failures where the request most likely never reached the server's handler
// (a dropped or refused connection, or the server asking us to come back), so
// sending it again cannot create a duplicate. A timeout is deliberately NOT
// here: the server may have processed the request and just been slow, and
// repeating it would add load to a server that is already struggling.
const CONNECTION_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);
const RETRYABLE_STATUSES = new Set([429, 502, 503]);

function isSafeToRetry(err) {
  const status = err?.response?.status;
  if (status) return RETRYABLE_STATUSES.has(status);
  return CONNECTION_ERROR_CODES.has(err?.code);
}

// Thrown when canSend() says this request must not go out (for example the
// instance it came from was blacklisted after the request was queued).
class SendCancelledError extends Error {}

// Fails closed: a canSend that throws counts as "do not send".
function isSendAllowed(canSend) {
  if (typeof canSend !== "function") return true;
  try {
    return Boolean(canSend());
  } catch (err) {
    reportError(`canSend check failed, not sending: ${err.message}`);
    return false;
  }
}

async function postSwitchStatus(payload, canSend) {
  for (let attempt = 0; ; attempt++) {
    // Checked before the first dispatch and again before every retry
    if (!isSendAllowed(canSend)) throw new SendCancelledError();

    try {
      return await axiosInstance.post(SWITCH_URL, payload);
    } catch (err) {
      if (attempt >= MAX_SEND_RETRIES || !isSafeToRetry(err)) throw err;

      const wait = RETRY_BASE_MS * 2 ** attempt;
      main.log(
        `Switch status request failed (${err.code || err.response?.status}), retrying in ${wait}ms`,
        "warn",
        "main_log",
      );
      await sleep(wait);
    }
  }
}

// Each user's requests are sent one after another, in the order they were
// queued: with retries and slow connections, a newer status could otherwise
// arrive first and then be overwritten by an older one. Different users do
// not wait for each other.
const lastRequestByUser = new Map(); // username -> promise of its latest request

/**
 * Sends the switch status to your API endpoint, after any earlier request for
 * the same user has finished.
 * @param {string} username
 * @param {string} avatarName
 * @param {{ canSend?: () => boolean }} [options] canSend is asked right before
 *   the request is sent and before every retry; when it says no, nothing is
 *   sent and the result is "blocked".
 * @returns {Promise<"success"|"fail"|"blocked">} resolves (never rejects) once
 *   the request has finished: "success" if the server accepted it, "fail" if
 *   it could not be delivered, "blocked" if canSend cancelled it
 */
function enqueueSwitchStatus(username, avatarName, { canSend } = {}) {
  const previous = lastRequestByUser.get(username) || Promise.resolve();
  const request = previous.then(() =>
    sendSwitchStatus(username, avatarName, canSend),
  );

  lastRequestByUser.set(username, request);
  request
    .finally(() => {
      // Forget the user once nothing newer has been queued behind this request
      if (lastRequestByUser.get(username) === request) {
        lastRequestByUser.delete(username);
      }
    })
    .catch(() => {}); // sendSwitchStatus never rejects; this only keeps it that way

  return request;
}

/**
 * Handles fetching discordId and sending the switch status to your API endpoint
 * @param {string} username
 * @param {string} avatarName
 * @param {(() => boolean) | undefined} canSend
 * @returns {Promise<"success"|"fail"|"blocked">} never rejects
 */
async function sendSwitchStatus(username, avatarName, canSend) {
  try {
    const discordId = normalizeDiscordId(await getConfig("Userid.discord_id"));

    const payload = {
      username,
      avatarName,
      ...(discordId && { discordId }),
    };

    await postSwitchStatus(payload, canSend);

    main.log(
      `Successfully sent API update for ${username}`,
      "info",
      "main_log",
    );
    return "success";
  } catch (apiErr) {
    if (apiErr instanceof SendCancelledError) {
      main.log(
        `Switch update for ${username} cancelled: instance is blacklisted`,
        "info",
        "main_log",
      );
      return "blocked";
    }

    let errorMsg = `enqueueSwitchStatus failed for ${username}: ${apiErr.message}`;
    if (apiErr.response) {
      errorMsg += ` | Status: ${apiErr.response.status} - ${JSON.stringify(apiErr.response.data)}`;
    }
    reportError(errorMsg, true);
    return "fail";
  }
}

module.exports = {
  normalizeDiscordId,
  enqueueSwitchStatus,
};
