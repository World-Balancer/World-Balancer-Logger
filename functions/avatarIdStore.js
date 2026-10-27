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

// Dedup cap: once we hit this many unique IDs, clear and start fresh.
const MAX_SEEN_AVATAR_IDS = 50000;

// New IDs are buffered and flushed when the buffer reaches FLUSH_BATCH_SIZE
// or every FLUSH_INTERVAL_MS, whichever comes first.
const FLUSH_BATCH_SIZE = 50;
const FLUSH_INTERVAL_MS = 2000;

// After unmark() removes an ID that is already on disk, the file is rewritten
// once after this delay (debounced, so a burst of failures = one rewrite).
const REWRITE_DELAY_MS = 5000;

class avatar_id_store {
  static _seenIds = null;
  static _storePath = null;
  static _loadPromise = null;

  static _pendingWrites = [];
  static _flushTimer = null;
  static _flushInFlight = null;
  static _rewriteTimer = null;

  static _getStorePath() {
    if (!avatar_id_store._storePath) {
      const { logpath } = require("../Configfiles/config.js");
      avatar_id_store._storePath = path.join(logpath, "seen_avatar_ids.txt");
    }
    return avatar_id_store._storePath;
  }

  /**
   * Loads previously-seen avatar IDs from disk into memory.
   * Concurrent callers share the same in-flight load promise.
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

  static async hasBeenSeen(avatarId) {
    const seenIds = await avatar_id_store._load();
    return seenIds.has(avatarId);
  }

  /**
   * Schedules a non-blocking flush of pending writes.
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

    avatar_id_store._flushInFlight = (async () => {
      await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
      await fs.promises.appendFile(storePath, data);
    })()
      .catch((err) => {
        // Put the IDs back so we retry on the next flush, except ones that
        // were unmarked while the write was running.
        const seen = avatar_id_store._seenIds;
        const stillSeen = seen ? toWrite.filter((id) => seen.has(id)) : toWrite;
        avatar_id_store._pendingWrites.unshift(...stillSeen);
        console.error(
          "[avatar_id_store] Failed to flush pending IDs:",
          err.message,
        );
      })
      .finally(() => {
        avatar_id_store._flushInFlight = null;
        // IDs that arrived during the write need their own flush.
        if (avatar_id_store._pendingWrites.length > 0) {
          avatar_id_store._scheduleFlush();
        }
      });

    return await avatar_id_store._flushInFlight;
  }

  /**
   * Synchronous flush, for app shutdown. Call from app "before-quit"
   * and from the uncaughtException handler.
   */
  static flushSync() {
    const hasRewrite = !!avatar_id_store._rewriteTimer;
    if (!hasRewrite && avatar_id_store._pendingWrites.length === 0) return;

    try {
      const storePath = avatar_id_store._getStorePath();
      fs.mkdirSync(path.dirname(storePath), { recursive: true });

      if (hasRewrite && avatar_id_store._seenIds) {
        // A rewrite was waiting: write the full set (it already contains
        // everything that was pending).
        clearTimeout(avatar_id_store._rewriteTimer);
        avatar_id_store._rewriteTimer = null;
        const ids = [...avatar_id_store._seenIds];
        fs.writeFileSync(storePath, ids.length ? ids.join("\n") + "\n" : "");
      } else {
        fs.appendFileSync(
          storePath,
          avatar_id_store._pendingWrites.join("\n") + "\n",
        );
      }
      avatar_id_store._pendingWrites = [];
    } catch (err) {
      console.error("[avatar_id_store] flushSync failed:", err.message);
    }
  }

  /**
   * Checks if an avatar ID is new and, if so, marks it as seen.
   * Returns true only when the ID is new (safe to send/log it now).
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
   * Same as checkAndMark; kept for existing callers.
   */
  static async markAsSeen(avatarId) {
    return avatar_id_store.checkAndMark(avatarId);
  }

  /**
   * Forgets an ID so it can be sent again. Call this when an upload failed.
   */
  static async unmark(avatarId) {
    const seenIds = await avatar_id_store._load();
    if (!seenIds.delete(avatarId)) return;

    // Not written to disk yet: just drop it from the buffer.
    const idx = avatar_id_store._pendingWrites.indexOf(avatarId);
    if (idx !== -1) {
      avatar_id_store._pendingWrites.splice(idx, 1);
      return;
    }

    // Already on disk (or being written right now): rewrite the file shortly.
    avatar_id_store._scheduleRewrite();
  }

  static _scheduleRewrite() {
    if (avatar_id_store._rewriteTimer) return;

    avatar_id_store._rewriteTimer = setTimeout(() => {
      avatar_id_store._rewriteTimer = null;
      avatar_id_store._rewrite();
    }, REWRITE_DELAY_MS);

    if (avatar_id_store._rewriteTimer.unref) {
      avatar_id_store._rewriteTimer.unref();
    }
  }

  /**
   * Rewrites the whole file from the in-memory set.
   */
  static async _rewrite() {
    // Let any running append finish first so it can't land after our write.
    if (avatar_id_store._flushInFlight) {
      await avatar_id_store._flushInFlight.catch(() => {});
    }
    if (avatar_id_store._flushInFlight) return; // someone else started one; retry later
    if (!avatar_id_store._seenIds) return;

    const storePath = avatar_id_store._getStorePath();
    const ids = [...avatar_id_store._seenIds];
    const data = ids.length ? ids.join("\n") + "\n" : "";
    // The snapshot already contains everything that was pending.
    avatar_id_store._pendingWrites = [];

    avatar_id_store._flushInFlight = (async () => {
      await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
      await fs.promises.writeFile(storePath, data);
    })()
      .catch((err) => {
        console.error("[avatar_id_store] Rewrite failed:", err.message);
        avatar_id_store._scheduleRewrite(); // try again later
      })
      .finally(() => {
        avatar_id_store._flushInFlight = null;
        // IDs that arrived during the write need their own flush.
        if (avatar_id_store._pendingWrites.length > 0) {
          avatar_id_store._scheduleFlush();
        }
      });

    await avatar_id_store._flushInFlight;
  }

  /**
   * Clears both the in-memory set and the persisted file.
   */
  static async clear() {
    if (avatar_id_store._flushTimer) {
      clearTimeout(avatar_id_store._flushTimer);
      avatar_id_store._flushTimer = null;
    }
    if (avatar_id_store._rewriteTimer) {
      clearTimeout(avatar_id_store._rewriteTimer);
      avatar_id_store._rewriteTimer = null;
    }

    // Wait for a running write so it can't append old IDs after we empty the file.
    if (avatar_id_store._flushInFlight) {
      await avatar_id_store._flushInFlight.catch(() => {});
    }

    avatar_id_store._seenIds = new Set();
    avatar_id_store._pendingWrites = [];

    const storePath = avatar_id_store._getStorePath();
    await fs.promises.mkdir(path.dirname(storePath), { recursive: true });
    await fs.promises.writeFile(storePath, "");
  }
}

module.exports = {
  avatar_id_store,
};
