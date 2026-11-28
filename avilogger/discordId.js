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

// The Discord ID of the person running the logger, shared by the avatar
// lookups (User-Agent) and the reports (request body).

const getConfig = require("../models/getConfig");
const { normalizeDiscordId } = require("./avatarQueue.js");

const DISCORD_ID_REGEX = /^\d{17,20}$/;

// The ID as last saved in Settings. getConfig caches for a few seconds, so the
// Settings save handler calls noteDiscordIdSaved() to skip that cache.
let savedDiscordId; // undefined = not saved since start, use getConfig

function noteDiscordIdSaved(id) {
  savedDiscordId = id;
}

/**
 * The Discord ID, or null when none is set or it is not 17-20 digits.
 * Read each time: the user may have changed it in Settings meanwhile.
 * Rejects when the setting cannot be read.
 */
async function readDiscordId() {
  const discordId = normalizeDiscordId(
    savedDiscordId !== undefined
      ? savedDiscordId
      : await getConfig("Userid.discord_id"),
  );
  return discordId && DISCORD_ID_REGEX.test(discordId) ? discordId : null;
}

module.exports = { readDiscordId, noteDiscordIdSaved };
