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
const main = require("./main");
const { app } = require("electron");
const { getDataDir } = require("./paths");

const { enqueueLogAvatar } = require("./avilogger/avatarQueue.js");
const { enqueueSwitchStatus } = require("./avilogger/avatarQueue2nd.js");

const appInstallPath = getDataDir();
const logpath = path.join(appInstallPath, "log");
const configDir = path.join(appInstallPath, "config");

const getConfig = require("./models/getConfig.js");
const { log_error } = require("./functions/logsclass.js");
const { avatar_id_store } = require("./functions/avatarIdStore.js");

// Lazy match up to the FIRST "avatar" keyword, then take the rest of the line
// as the name. (The old greedy `.*avatar\s+` latched onto the LAST "avatar"
// in the line, so a name ending in "avatar" + a trailing "\r" came out empty.)
const SWITCH_REGEX = /Switching\s+(.+?)\s+to\s+.*?avatar\s+(.+?)\s*$/;
const AVATAR_API_REGEX = /avatars\/(avtr_[a-f0-9-]+)/;
const ASSET_BUNDLE_REGEX = /\[AssetBundleDownloadManager\].*?(avtr_[a-f0-9-]+)/;

const DESTINATION_REGEX =
  /\[Behaviour\] Destination set:\s+(wrld_[a-f0-9-]+)(?::(\S+))?/;

function parseDestination(match) {
  const worldId = match[1];
  const rest = match[2] || ""; // e.g. 10635~private(usr_...)~region(use)
  const [instanceId, ...tagParts] = rest.split("~");

  const tags = {};
  for (const part of tagParts) {
    const m = part.match(/^(\w+)(?:\((.*)\))?$/); // name(value) or bare name
    if (m) tags[m[1]] = m[2] ?? true;
  }

  return { worldId, instanceId, tags };
}

function getInstanceType(tags) {
  if (tags.group) {
    switch (tags.groupAccessType) {
      case "public":
        return "Group Public";
      case "plus":
        return "Group+";
      case "members":
        return "Group";
      default:
        return `Group (${tags.groupAccessType || "unknown"})`;
    }
  }
  if (tags.private) return tags.canRequestInvite ? "Invite+" : "Invite";
  if (tags.friends) return "Friends";
  if (tags.hidden) return "Friends+";
  return "Public";
}

// Max bytes read per pass. Keeps every string far below V8's ~512 MB limit,
// no matter how large output_log grows.
const READ_CHUNK_BYTES = 16 * 1024 * 1024; // 16 MB

// If true, the first log file picked up after the app starts is read from its
// current end (history is skipped). Log files created later are read from byte 0.
const SKIP_BACKLOG_ON_STARTUP = true;

if (!fs.existsSync(logpath)) fs.mkdirSync(logpath, { recursive: true });
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

let currentLogFile = null;
let lastReadPosition = 0;
let isFirstFileSelection = true;

function reportError(message, emitToMain = false) {
  log_error.writeErrorToFile(message);
  if (emitToMain) {
    main.log(message, "error", "main_log");
  }
}

// ---------------------------------------------------------------------------
// Blacklist (world ids + group ids that must NOT be sent to our server)
// ---------------------------------------------------------------------------

const BLACKLIST_URL =
  "https://raw.githubusercontent.com/World-Balancer/avatar-logging-system-blacklist/main/blacklist.json";
const BLACKLIST_REFRESH_MS = 5 * 60 * 1000; // re-download every 5 minutes
const BLACKLIST_FETCH_TIMEOUT_MS = 10 * 1000;
const blacklistCachePath = path.join(configDir, "blacklist-cache.json");

let blockedWorlds = new Set();
let blockedGroups = new Set();
let blacklistEtag = null; // ETag of the last blacklist we downloaded successfully

// What instance the player is currently in, and whether it is blocked
let currentWorldId = null;
let currentGroupId = null;
let isBlocked = false;

/**
 * File format: { "world": [ { "id": "wrld_..." }, ... ],
 *                "group": [ { "id": "grp_..." }, ... ] }
 * Plain strings are accepted in the arrays as well.
 */
function applyBlacklistData(data) {
  const toSet = (list) =>
    new Set(
      (Array.isArray(list) ? list : [])
        .map((entry) => (typeof entry === "string" ? entry : entry?.id))
        .filter((id) => typeof id === "string" && id.trim())
        .map((id) => id.trim()),
    );

  blockedWorlds = toSet(data?.world);
  blockedGroups = toSet(data?.group);
}

function loadBlacklistCache() {
  try {
    if (fs.existsSync(blacklistCachePath)) {
      applyBlacklistData(
        JSON.parse(fs.readFileSync(blacklistCachePath, "utf8")),
      );
      main.log(
        `Loaded cached blacklist (${blockedWorlds.size} worlds, ${blockedGroups.size} groups)`,
        "info",
        "main_log",
      );
    }
  } catch (err) {
    reportError(`Failed reading blacklist cache: ${err.message}`);
  }
}

function updateBlockedState() {
  const worldBlocked = Boolean(
    currentWorldId && blockedWorlds.has(currentWorldId),
  );
  const groupBlocked = Boolean(
    currentGroupId && blockedGroups.has(currentGroupId),
  );
  const nowBlocked = worldBlocked || groupBlocked;

  if (nowBlocked !== isBlocked) {
    isBlocked = nowBlocked;
    if (isBlocked) {
      const what = worldBlocked
        ? `world ${currentWorldId}`
        : `group ${currentGroupId}`;
      main.log(
        `Blacklisted ${what}: not sending data while in this instance`,
        "warn",
        "main_log",
      );
    } else {
      main.log(
        "Left blacklisted instance: sending resumed",
        "info",
        "main_log",
      );
    }
  }
}

async function refreshBlacklist() {
  try {
    // Conditional request: if the file hasn't changed, GitHub answers
    // "304 Not Modified" with no body and we keep the lists we already have.
    const headers = {};
    if (blacklistEtag) headers["If-None-Match"] = blacklistEtag;

    const res = await fetch(BLACKLIST_URL, {
      headers,
      cache: "no-store",
      signal: AbortSignal.timeout(BLACKLIST_FETCH_TIMEOUT_MS),
    });

    if (res.status === 304) return; // unchanged since the last download
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const text = await res.text();
    applyBlacklistData(JSON.parse(text)); // throws on bad JSON, keeps old lists
    blacklistEtag = res.headers.get("etag"); // only remembered after a good parse
    await fs.promises.writeFile(blacklistCachePath, text);

    main.log(
      `Blacklist updated (${blockedWorlds.size} worlds, ${blockedGroups.size} groups)`,
      "info",
      "main_log",
    );

    // An entry added while the player is already in that instance applies at once
    updateBlockedState();
  } catch (err) {
    // Keep using the last good lists (in memory or from the cache file)
    reportError(`Failed refreshing blacklist: ${err.message}`, true);
  }
}

function handleDestination(destMatch) {
  const { worldId, instanceId, tags } = parseDestination(destMatch);
  const instanceType = getInstanceType(tags);

  const groupInfo = typeof tags.group === "string" ? `, ${tags.group}` : "";

  main.log(
    `Destination set: ${worldId} instance ${instanceId} (${instanceType}${groupInfo}, region ${tags.region || "?"})`,
    "info",
    "main_log",
  );

  currentWorldId = worldId;
  currentGroupId = typeof tags.group === "string" ? tags.group : null;
  updateBlockedState();
}

/**
 * Scans backwards from the end of the log (up to ~64 MB) for the most recent
 * "Destination set" line. Used when the app starts mid-session and skips the
 * backlog, so it still knows which instance the player is already in.
 */
async function findLastDestination(file, size) {
  const BLOCK = 8 * 1024 * 1024;
  const MAX_SCAN = 64 * 1024 * 1024;
  const OVERLAP = 4096; // so a line cut at a block edge is still seen whole

  const handle = await fs.promises.open(file, "r");
  try {
    let end = size;
    let scanned = 0;

    while (end > 0 && scanned < MAX_SCAN) {
      const start = Math.max(0, end - BLOCK);
      const buffer = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);

      const lines = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        const match = lines[i].match(DESTINATION_REGEX);
        if (match) return match;
      }

      scanned += end - start;
      end = start > 0 ? start + OVERLAP : 0;
    }
  } finally {
    await handle.close();
  }
  return null;
}

// ---------------------------------------------------------------------------

async function checkForNewFiles() {
  try {
    const logDirectory = await getConfig("Directories.LogDirectory");

    if (!logDirectory) {
      reportError("Log directory path is missing or null.");
      return;
    }

    const logFileNames = await fs.promises.readdir(logDirectory);
    const newLogFileNames = logFileNames.filter((name) =>
      name?.startsWith("output_log"),
    );

    if (newLogFileNames.length > 0) {
      newLogFileNames.sort();
      const latestLogFile = path.join(
        logDirectory,
        newLogFileNames[newLogFileNames.length - 1],
      );

      if (latestLogFile !== currentLogFile) {
        currentLogFile = latestLogFile;

        // New log = new VRChat session: forget the previous instance
        currentWorldId = null;
        currentGroupId = null;
        updateBlockedState();

        if (isFirstFileSelection && SKIP_BACKLOG_ON_STARTUP) {
          // Skip history that existed before the app started...
          const { size } = await fs.promises.stat(currentLogFile);
          lastReadPosition = size;

          // ...but still work out which instance the player is in right now
          const lastDestination = await findLastDestination(
            currentLogFile,
            size,
          );
          if (lastDestination) handleDestination(lastDestination);
        } else {
          lastReadPosition = 0;
        }
        isFirstFileSelection = false;

        main.log(
          `Switching to new log file: ${currentLogFile}`,
          "info",
          "main_log",
        );
      }
    }
  } catch (err) {
    reportError(`Failed reading directory structures: ${err.message}`, true);
  }
}

/**
 * Reads up to READ_CHUNK_BYTES of new data and only consumes whole lines.
 * Returns [completeLines, newLastReadPosition]. The position always lands
 * right after a newline, so no partial-line buffer is needed.
 */
async function readNewLogs(fileSize) {
  const bytesAvailable = fileSize - lastReadPosition;
  if (bytesAvailable <= 0) return [[], lastReadPosition];

  const toRead = Math.min(bytesAvailable, READ_CHUNK_BYTES);
  const buffer = Buffer.allocUnsafe(toRead);

  const handle = await fs.promises.open(currentLogFile, "r");
  let bytesRead;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, toRead, lastReadPosition));
  } finally {
    await handle.close();
  }

  if (bytesRead === 0) return [[], lastReadPosition];

  const lastNewline = buffer.lastIndexOf(0x0a, bytesRead - 1);

  if (lastNewline === -1) {
    if (bytesRead === READ_CHUNK_BYTES) {
      // A single line longer than the whole chunk: skip it.
      reportError(
        `Skipped a log line longer than ${READ_CHUNK_BYTES} bytes.`,
        true,
      );
      return [[], lastReadPosition + bytesRead];
    }
    // Incomplete last line; wait for more data.
    return [[], lastReadPosition];
  }

  const text = buffer.toString("utf8", 0, lastNewline);
  // VRChat logs on Windows use \r\n; strip the \r so it never ends up in a match
  return [text.split(/\r?\n/), lastReadPosition + lastNewline + 1];
}

(async function monitorAndSend() {
  try {
    await new Promise((resolve) => app.once("db-ready", resolve));

    // Use the last saved blacklist right away, then fetch a fresh copy
    loadBlacklistCache();
    await refreshBlacklist();
    setInterval(refreshBlacklist, BLACKLIST_REFRESH_MS);

    while (true) {
      let hasMore = false;
      await checkForNewFiles();

      if (currentLogFile) {
        const stats = await fs.promises.stat(currentLogFile);

        if (stats.size > lastReadPosition) {
          const prevPosition = lastReadPosition;
          const [newLogs, newLastReadPosition] = await readNewLogs(stats.size);

          for (let i = 0; i < newLogs.length; i++) {
            const log = newLogs[i];
            if (!log) continue;

            // Destination lines are always processed: they decide whether
            // the instance the player is in is blacklisted.
            const destMatch = log.match(DESTINATION_REGEX);
            if (destMatch) {
              handleDestination(destMatch);
              continue;
            }

            // In a blacklisted world/group: skip switchMatch and apiMatch.
            // (Avatar IDs are NOT marked as seen, so they are still logged
            // later if the player sees them in an allowed instance.)
            if (isBlocked) continue;

            const switchMatch = log.match(SWITCH_REGEX);
            if (switchMatch) {
              const username = switchMatch[1].trim();
              const avatarName = switchMatch[2].trim();

              if (!username || !avatarName) {
                // Never send an empty name to the API (it answers 400)
                main.log(
                  `Skipped switch line with empty name: ${log}`,
                  "warn",
                  "main_log",
                );
              } else {
                main.log(
                  `User ${username} switching to ${avatarName}`,
                  "info",
                  "main_log",
                );

                enqueueSwitchStatus(username, avatarName);
              }
            }

            const apiMatch = log.match(AVATAR_API_REGEX);
            const assetBundleMatch = log.match(ASSET_BUNDLE_REGEX);
            const avatarIdMatch = apiMatch || assetBundleMatch;

            if (avatarIdMatch) {
              const avatarId = avatarIdMatch[1];

              const isNewAvatarId =
                await avatar_id_store.checkAndMark(avatarId);
              if (!isNewAvatarId) {
                continue;
              }

              main.log(`Found avatar ID: ${avatarId}`, "info", "main_log");

              enqueueLogAvatar(avatarId, "system_log");
            }
          }

          lastReadPosition = newLastReadPosition;
          // Still catching up on a backlog: skip the sleep and read the next chunk
          hasMore =
            lastReadPosition > prevPosition && lastReadPosition < stats.size;
        } else if (stats.size < lastReadPosition) {
          lastReadPosition = 0;
        }
      } else {
        main.log(
          "No log file selected. Waiting for a new log file...",
          "info",
          "main_log",
        );
      }

      if (!hasMore) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
  } catch (error) {
    reportError(`Error stack of monitor of VRChat: ${error.message}`, true);
  }
})();

const SHUTDOWN_FLUSH_TIMEOUT_MS = 3000;

/**
 * Waits for in-flight avatar ID appends/rewrites (and anything buffered) to
 * reach disk. If that takes too long or fails, falls back to flushSync(),
 * which writes the full in-memory set synchronously. Never rejects.
 */
async function shutdownAvatarStore() {
  let timer;
  try {
    await Promise.race([
      avatar_id_store.flushAll(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    reportError(`Avatar ID store flush failed: ${err.message}`);
  } finally {
    clearTimeout(timer);
    avatar_id_store.flushSync(); // no-op if flushAll finished everything
  }
}

process.on("uncaughtException", (err, origin) => {
  reportError(
    `Uncaught Exception at: ${new Date().toISOString()}\nError: ${err.message}\nStack: ${err.stack}\nOrigin: ${origin}`,
  );
  shutdownAvatarStore().finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason, promise) => {
  reportError(
    `Unhandled Rejection at: ${new Date().toISOString()}\nReason: ${reason}\nPromise: ${promise}`,
  );
});
