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

// Batch writes instead of hitting disk on every single new ID. New IDs are
// buffered in memory and flushed to disk either when the buffer reaches
// FLUSH_BATCH_SIZE or every FLUSH_INTERVAL_MS, whichever comes first.
const FLUSH_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 2000;

class avatar_id_store {
  // In-memory cache mirroring the file contents, so we don't hit disk on
  // every single check. Loaded lazily on first use.
  static _seenIds = null;
  static _storePath = null;
  static _loadPromise = null;

  // IDs that have been added to _seenIds but not yet flushed to disk.
  static _pendingWrites = [];
  static _flushTimer = null;
  static _flushInFlight = null;

  static _getStorePath() {
    if (!avatar_id_store._storePath) {
      const { logpath } = require("../Configfiles/config.js");
      avatar_id_store._storePath = path.join(logpath, "seen_avatar_ids.txt");
    }
    return avatar_id_store._storePath;
  }

  /**
   * Loads previously-seen avatar IDs from disk into memory.
   * Safe to call concurrently; the file is only ever read once (concurrent
   * callers share the same in-flight load promise instead of racing).
   */
  static async _load() {
    if (avatar_id_store._seenIds) return avatar_id_store._seenIds;

    if (!avatar_id_store._loadPromise) {
      avatar_id_store._loadPromise = (async () => {
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
      })();
    }

    return await avatar_id_store._loadPromise;
  }

  /**
   * Returns true if this avatar ID has already been seen/sent before.
   */
  static async hasBeenSeen(avatarId) {
    const seenIds = await avatar_id_store._load();
    return seenIds.has(avatarId);
  }

  /**
   * Schedules a flush of pending writes without blocking the caller.
   * Flushing is async (non-blocking) and coalesces concurrent calls into a
   * single in-flight write so bursts don't queue up redundant disk writes.
   */
  static _scheduleFlush() {
    if (avatar_id_store._flushTimer) return; // already scheduled

    avatar_id_store._flushTimer = setTimeout(() => {
      avatar_id_store._flushTimer = null;
      avatar_id_store._flush();
    }, FLUSH_INTERVAL_MS);

    // Don't let this timer keep the process alive on its own.
    if (avatar_id_store._flushTimer.unref) {
      avatar_id_store._flushTimer.unref();
    }
  }

  static async _flush() {
    if (avatar_id_store._pendingWrites.length === 0) return;

    // Coalesce concurrent flush calls into a single write operation.
    if (avatar_id_store._flushInFlight) {
      return avatar_id_store._flushInFlight;
    }

    const toWrite = avatar_id_store._pendingWrites;
    avatar_id_store._pendingWrites = [];

    const storePath = avatar_id_store._getStorePath();
    const data = toWrite.join("\n") + "\n";

    avatar_id_store._flushInFlight = fs.promises
      .appendFile(storePath, data)
      .catch((err) => {
        // If the write failed, put the IDs back so we retry on next flush
        // rather than silently losing the dedup record.
        avatar_id_store._pendingWrites.unshift(...toWrite);
        console.error(
          "[avatar_id_store] Failed to flush pending IDs:",
          err.message,
        );
      })
      .finally(() => {
        avatar_id_store._flushInFlight = null;
      });

    return await avatar_id_store._flushInFlight;
  }

  /**
   * Records an avatar ID as seen: adds it to the in-memory set immediately
   * and queues it for a batched, non-blocking write to disk.
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
    avatar_id_store._pendingWrites.push(avatarId);

    if (avatar_id_store._pendingWrites.length >= FLUSH_BATCH_SIZE) {
      // Buffer is full: flush right away instead of waiting for the timer.
      avatar_id_store._flush();
    } else {
      avatar_id_store._scheduleFlush();
    }

    return true;
  }

  /**
   * Checks if an avatar ID is new and, if so, marks it as seen — all in a
   * single Set lookup instead of checking twice.
   * Returns true only when the ID is new (i.e. it's safe to send/log it now).
   */
  static async checkAndMark(avatarId) {
    const seenIds = await avatar_id_store._load();

    if (seenIds.has(avatarId)) {
      return false;
    }

    if (seenIds.size >= MAX_SEEN_AVATAR_IDS) {
      await avatar_id_store.clear();
    }

    avatar_id_store._seenIds.add(avatarId);
    avatar_id_store._pendingWrites.push(avatarId);

    if (avatar_id_store._pendingWrites.length >= FLUSH_BATCH_SIZE) {
      avatar_id_store._flush();
    } else {
      avatar_id_store._scheduleFlush();
    }

    return true;
  }

  /**
   * Clears both the in-memory set and the persisted file.
   */
  static async clear() {
    avatar_id_store._seenIds = new Set();
    avatar_id_store._pendingWrites = [];
    if (avatar_id_store._flushTimer) {
      clearTimeout(avatar_id_store._flushTimer);
      avatar_id_store._flushTimer = null;
    }

    const storePath = avatar_id_store._getStorePath();
    await fs.promises.writeFile(storePath, "");
  }
}

module.exports = {
  avatar_id_store,
};
