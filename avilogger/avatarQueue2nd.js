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
  maxRedirects: 0,
  httpAgent,
  httpsAgent,
  headers: {
    "Content-Type": "application/json",
    "User-Agent": "World Balancer/0.0.3 contact@worldbalancer.com",
    Connection: "keep-alive",
  },
});

function reportError(message, emitToMain = false) {
  log_error.writeErrorToFile(message);
  if (emitToMain) {
    main.log(message, "error", "main_log");
  }
}

/**
 * Handles fetching discordId and sending the switch status to your API endpoint
 * @param {string} username
 * @param {string} avatarName
 */
async function enqueueSwitchStatus(username, avatarName) {
  try {
    const discordId = await getConfig("Userid.discord_id");

    await axiosInstance.post(
      "https://aswb.worldbalancer.com/v9/api/avatar-check",
      {
        username,
        avatarName,
        discordId,
      },
    );

    main.log(
      `Successfully sent API update for ${username}`,
      "info",
      "main_log",
    );
  } catch (apiErr) {
    let errorMsg = ``;
    if (apiErr.response) {
      errorMsg += ` | Status: ${apiErr.response.status} - ${JSON.stringify(apiErr.response.data)}`;
    }
    reportError(errorMsg, true);
  }
}

module.exports = {
  enqueueSwitchStatus,
};
