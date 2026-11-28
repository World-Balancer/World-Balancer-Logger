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
//
// NOTE: this ID is typed in by the user and never verified. The server must
// treat it as a label, not as proof of who sent a request.
//
// Settings are read straight from the config table on every call (no cache),
// so a change in Settings applies at once, and a database failure is thrown
// instead of looking like "not set".

const Config = require("../models/Config");
const { normalizeDiscordId } = require("./avatarQueue.js");

const DISCORD_ID_REGEX = /^\d{17,20}$/;

// One saved setting (null when it was never saved). Rejects when the database
// cannot be read.
async function readSetting(key) {
  const row = await Config.findOne({ where: { keyid: key } });
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return null;
  }
}

/** The Discord ID, or null when none is set or it is not 17-20 digits. */
async function readDiscordId() {
  const raw = await readSetting("Userid.discord_id");
  const id = normalizeDiscordId(raw == null ? raw : String(raw));
  return id && DISCORD_ID_REGEX.test(id) ? id : null;
}

/**
 * The Discord ID to add to avatar-name lookups, or null when the person has
 * not allowed that (Settings: "Send my Discord ID with name lookups").
 */
async function readLookupDiscordId() {
  const allowed = await readSetting("Userid.send_with_lookups");
  return allowed === true ? readDiscordId() : null;
}

module.exports = { readDiscordId, readLookupDiscordId };
