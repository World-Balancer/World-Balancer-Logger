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

const fs = require("fs");
const path = require("path");

// Dedup cap: keep the seen-avatar-ID set from growing forever across a very
// long-running process. Once we hit this many unique IDs, we clear and start
// fresh (older IDs simply become eligible to be logged again).
const MAX_SEEN_AVATAR_IDS = 50000;

class avatar_id_store {
  // In-memory cache mirroring the file contents, so we don't hit disk on
  // every single check. Loaded lazily on first use.
  static _seenIds = null;
  static _storePath = null;

  static _getStorePath() {
    if (!avatar_id_store._storePath) {
      const { logpath } = require("../Configfiles/config.js");
      avatar_id_store._storePath = path.join(logpath, "seen_avatar_ids.log");
    }
    return avatar_id_store._storePath;
  }

  /**
   * Loads previously-seen avatar IDs from disk into memory.
   * Safe to call multiple times; only reads the file once.
   */
  static async _load() {
    if (avatar_id_store._seenIds) return avatar_id_store._seenIds;

    const storePath = avatar_id_store._getStorePath();
    const set = new Set();

    if (fs.existsSync(storePath)) {
      const contents = await fs.promises.readFile(storePath, "utf8");
      for (const line of contents.split("\n")) {
        const id = line.trim();
        if (id) set.add(id);
      }
    }

    avatar_id_store._seenIds = set;
    return set;
  }

  /**
   * Returns true if this avatar ID has already been seen/sent before.
   */
  static async hasBeenSeen(avatarId) {
    const seenIds = await avatar_id_store._load();
    return seenIds.has(avatarId);
  }

  /**
   * Records an avatar ID as seen: adds it to the in-memory set and appends
   * it to the persistent file so it survives restarts.
   * Returns false if the ID was already seen (nothing written), true if it
   * was newly recorded.
   */
  static async markAsSeen(avatarId) {
    const seenIds = await avatar_id_store._load();

    if (seenIds.has(avatarId)) {
      return false;
    }

    // Reset if we've hit the cap, so the file/set doesn't grow forever.
    if (seenIds.size >= MAX_SEEN_AVATAR_IDS) {
      await avatar_id_store.clear();
    }

    avatar_id_store._seenIds.add(avatarId);

    const storePath = avatar_id_store._getStorePath();
    fs.appendFileSync(storePath, `${avatarId}\n`);

    return true;
  }

  /**
   * Convenience combo: checks if the ID is new, and if so marks it as seen
   * in the same call. Returns true only when the ID is new (i.e. it's safe
   * to send/log it now).
   */
  static async checkAndMark(avatarId) {
    const alreadySeen = await avatar_id_store.hasBeenSeen(avatarId);
    if (alreadySeen) return false;
    return avatar_id_store.markAsSeen(avatarId);
  }

  /**
   * Clears both the in-memory set and the persisted file.
   */
  static async clear() {
    avatar_id_store._seenIds = new Set();
    const storePath = avatar_id_store._getStorePath();
    if (fs.existsSync(storePath)) {
      fs.writeFileSync(storePath, "");
    }
  }
}

module.exports = {
  avatar_id_store,
};
