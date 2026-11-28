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

// Remembers, on disk, the reports whose outcome is not known: the request went
// out but the app never saw the answer (timeout, server error, app closed
// mid-send). If the same report is sent again, even after a restart, a 409
// from the server then most likely means that interrupted report, and the
// window can say so instead of showing a plain "duplicate".
//
// Nothing in here may throw into the report sender: every failure is logged
// and ignored (the worst case is the plain "duplicate" message).

const fs = require("fs");
const path = require("path");
const { getDataDir } = require("../paths");

const FILE_NAME = "pending-reports.json";
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // an old guess is not worth keeping

let entries = null; // key -> time the unconfirmed attempt started

function filePath() {
  return path.join(getDataDir(), FILE_NAME);
}

function load() {
  if (entries) return entries;
  entries = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(filePath(), "utf8"));
    const now = Date.now();
    for (const [key, startedAt] of Object.entries(data)) {
      if (typeof startedAt === "number" && now - startedAt < MAX_AGE_MS) {
        entries.set(key, startedAt);
      }
    }
  } catch {
    // no file yet, or unreadable: start empty
  }
  return entries;
}

function save() {
  try {
    const tmp = `${filePath()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)));
    fs.renameSync(tmp, filePath()); // never leave a half-written file
  } catch (err) {
    console.error(`pendingReports.save failed: ${err.message}`);
  }
}

/** True when an earlier attempt for this key never got a clear answer. */
function hasUnconfirmed(key) {
  return load().has(key);
}

/** Written before the request goes out, so even a crash mid-send is remembered. */
function markUnconfirmed(key) {
  const map = load();
  if (map.has(key)) return;
  map.set(key, Date.now());
  save();
}

/** The outcome is known (stored, refused, or already on file). */
function clearUnconfirmed(key) {
  if (load().delete(key)) save();
}

module.exports = { hasUnconfirmed, markUnconfirmed, clearUnconfirmed };
