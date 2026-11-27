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

// Keeps the list shown in the "Avatars" tab: every avatar ID the log monitor
// has seen, with its name from the World Balancer avatar server.
//
// Each entry has a lookup state:
//   "loading" - the server has not answered yet
//   "found"   - name is set
//   "private" - the server said "Avatar not found" (shown as "Private")
//   "error"   - the server could not be asked (the window offers Retry)
//
// Nothing in here may throw into the log monitor: every entry point catches
// its own errors.

const main = require("../main");
const { lookupAvatar, forgetAvatar } = require("./avatarLookup.js");

const MAX_ENTRIES = 300;

const entries = new Map(); // avatar id -> entry

function snapshot(entry) {
  return { ...entry };
}

function emit(message) {
  try {
    if (typeof main.sendToWindow === "function") {
      main.sendToWindow("seen-avatars-update", message);
    }
  } catch {
    // the window may be closed; the list is still kept
  }
}

function trimEntries() {
  while (entries.size > MAX_ENTRIES) {
    let oldestId = null;
    let oldestSeen = Infinity;
    for (const [id, e] of entries) {
      if (e.lastSeen < oldestSeen) {
        oldestSeen = e.lastSeen;
        oldestId = id;
      }
    }
    entries.delete(oldestId);
    emit({ type: "remove", id: oldestId });
  }
}

function startLookup(entry) {
  entry.lookup = "loading";
  entry.name = null;
  entry.error = null;
  const id = entry.id;
  lookupAvatar(id).then((result) => {
    // The entry may have been cleared or removed while we waited
    if (entries.get(id) !== entry) return;
    entry.lookup = result.status;
    entry.name = result.status === "found" ? result.name : null;
    entry.error = result.status === "error" ? result.message : null;
    emit({ type: "upsert", avatar: snapshot(entry) });
  });
}

/** An avatar ID was seen in the log. */
function noteAvatarId(id, now = Date.now()) {
  try {
    let entry = entries.get(id);
    if (!entry) {
      entry = {
        id,
        name: null,
        lookup: "loading",
        error: null,
        firstSeen: now,
        lastSeen: now,
        count: 0,
      };
      entries.set(id, entry);
      trimEntries();
      entry.count += 1;
      emit({ type: "upsert", avatar: snapshot(entry) });
      startLookup(entry);
      return;
    }
    entry.lastSeen = now;
    entry.count += 1;
    emit({ type: "upsert", avatar: snapshot(entry) });
  } catch (err) {
    console.error(`seenAvatars.noteAvatarId failed: ${err.message}`);
  }
}

/** Asks the server again (Retry button, or to see if a private avatar went public). */
function retryLookup(id) {
  try {
    const entry = entries.get(id);
    if (!entry || entry.lookup === "loading") return false;
    forgetAvatar(id);
    startLookup(entry);
    emit({ type: "upsert", avatar: snapshot(entry) });
    return true;
  } catch (err) {
    console.error(`seenAvatars.retryLookup failed: ${err.message}`);
    return false;
  }
}

/** All seen avatars, most recently seen first. */
function getSeenAvatars() {
  return [...entries.values()]
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .map(snapshot);
}

function clearSeenAvatars() {
  entries.clear();
  emit({ type: "clear" });
}

module.exports = {
  noteAvatarId,
  retryLookup,
  getSeenAvatars,
  clearSeenAvatars,
};
