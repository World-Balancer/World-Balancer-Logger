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

const { enqueueLogAvatar } = require("./avilogger/avatarQueue.js");
const { enqueueSwitchStatus } = require("./avilogger/avatarQueue2nd.js");

const appInstallPath = app.getPath("userData");
const logpath = path.join(appInstallPath, "log");
const configDir = path.join(appInstallPath, "config");

const getConfig = require("./models/getConfig.js");
const { log_error } = require("./functions/logsclass.js");

const SWITCH_REGEX = /Switching\s+(.*?)\s+to.*avatar\s+(.*)/;
const AVATAR_API_REGEX = /avatars\/(avtr_[a-f0-9-]+)/;

// Safety cap: if a single new chunk somehow exceeds this, we bail rather
// than buffering an unbounded string in memory (e.g. corrupted/huge file).
// Note: a chunk this size can cost several GB of actual process memory once
// read into a JS string and split into lines (UTF-16 + array overhead).
const MAX_CHUNK_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

if (!fs.existsSync(logpath)) fs.mkdirSync(logpath, { recursive: true });
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

let currentLogFile = null;
let lastReadPosition = 0;
let pendingPartialLine = "";

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
    const newLogFileNames = logFileNames.filter(name => name && name.startsWith("output_log"));

    if (newLogFileNames.length > 0) {
      newLogFileNames.sort();
      const latestLogFile = path.join(logDirectory, newLogFileNames[newLogFileNames.length - 1]);

      if (latestLogFile !== currentLogFile) {
        currentLogFile = latestLogFile;
        lastReadPosition = 0;
        pendingPartialLine = "";
        main.log(`Switching to new log file: ${currentLogFile}`, "info", "main_log");
      }
    }
  } catch (err) {
    reportError(`Failed reading directory structures: ${err.message}`, true);
  }
}

/**
 * Reads only the *new* bytes appended to the log file since lastReadPosition,
 * using a stream instead of loading the whole file into memory.
 * Returns [newCompleteLines, newLastReadPosition].
 */
async function readNewLogs(fileSize) {
  return new Promise((resolve, reject) => {
    const bytesToRead = fileSize - lastReadPosition;

    if (bytesToRead <= 0) {
      resolve([[], lastReadPosition]);
      return;
    }

    if (bytesToRead > MAX_CHUNK_BYTES) {
      reportError(
        `New log data (${bytesToRead} bytes) exceeds safety cap of ${MAX_CHUNK_BYTES} bytes; skipping ahead to avoid excessive memory use.`,
        true,
      );
      pendingPartialLine = "";
      resolve([[], fileSize]);
      return;
    }

    const stream = fs.createReadStream(currentLogFile, {
      encoding: "utf8",
      start: lastReadPosition,
      end: fileSize - 1,
    });

    let newData = pendingPartialLine;

    stream.on("data", chunk => {
      newData += chunk;
    });

    stream.on("end", () => {
      const lines = newData.split("\n");
      pendingPartialLine = lines.pop() || "";
      resolve([lines, fileSize]);
    });

    stream.on("error", err => {
      reject(err);
    });
  });
}

async function monitorAndSend() {
  try {
    while (true) {
      await checkForNewFiles();

      if (currentLogFile) {
        const stats = await fs.promises.stat(currentLogFile);

        if (stats.size > lastReadPosition) {
          const [newLogs, newLastReadPosition] = await readNewLogs(stats.size);

          for (let i = 0; i < newLogs.length; i++) {
            const log = newLogs[i];
            if (!log) continue;

            const switchMatch = log.match(SWITCH_REGEX);
            if (switchMatch) {
              const username = switchMatch[1].trim();
              const avatarName = switchMatch[2].trim();
              main.log(`User ${username} switching to ${avatarName}`, "info", "main_log");

              enqueueSwitchStatus(username, avatarName);
            }

            const apiMatch = log.match(AVATAR_API_REGEX);
            if (apiMatch) {
              const avatarId = apiMatch[1];
              main.log(`Found avatar ID via API: ${avatarId}`, "info", "main_log");

              enqueueLogAvatar(avatarId, "system_log");
            }
          }
          lastReadPosition = newLastReadPosition;
        } else if (stats.size < lastReadPosition) {
          lastReadPosition = 0;
          pendingPartialLine = "";
        }
      } else {
        main.log("No log file selected. Waiting for a new log file...", "info", "main_log");
      }

      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  } catch (error) {
    reportError(`Error stack of monitor of VRChat: ${error.message}`, true);
  }
}

monitorAndSend();

process.on("uncaughtException", (err, origin) => {
  reportError(`Uncaught Exception at: ${new Date().toISOString()}\nError: ${err.message}\nStack: ${err.stack}\nOrigin: ${origin}`);
  setTimeout(() => process.exit(1), 100);
});

process.on("unhandledRejection", (reason, promise) => {
  reportError(`Unhandled Rejection at: ${new Date().toISOString()}\nReason: ${reason}\nPromise: ${promise}`);
});
