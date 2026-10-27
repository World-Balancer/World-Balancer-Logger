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

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
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

/**
 * Handles fetching discordId and sending the switch status to your API endpoint
 * @param {string} username
 * @param {string} avatarName
 */
async function enqueueSwitchStatus(username, avatarName) {
  try {
    const discordId = normalizeDiscordId(await getConfig("Userid.discord_id"));

    const payload = {
      username,
      avatarName,
      ...(discordId && { discordId }),
    };

    await axiosInstance.post(
      "https://aswb.worldbalancer.com/v9/api/avatar-check",
      payload,
    );

    main.log(
      `Successfully sent API update for ${username}`,
      "info",
      "main_log",
    );
  } catch (apiErr) {
    let errorMsg = `enqueueSwitchStatus failed for ${username}: ${apiErr.message}`;
    if (apiErr.response) {
      errorMsg += ` | Status: ${apiErr.response.status} - ${JSON.stringify(apiErr.response.data)}`;
    }
    reportError(errorMsg, true);
  }
}

module.exports = {
  normalizeDiscordId,
  enqueueSwitchStatus,
};
