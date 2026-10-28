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

        if (isFirstFileSelection && SKIP_BACKLOG_ON_STARTUP) {
          // Skip history that existed before the app started
          const { size } = await fs.promises.stat(currentLogFile);
          lastReadPosition = size;
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

            const destMatch = log.match(DESTINATION_REGEX);
            if (destMatch) {
              const { worldId, instanceId, tags } = parseDestination(destMatch);
              const instanceType = getInstanceType(tags);

              main.log(
                `Destination set: ${worldId} instance ${instanceId} (${instanceType}, region ${tags.region || "?"})`,
                "info",
                "main_log",
              );
            }

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
