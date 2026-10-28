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

// Log files created after this moment were created while the app was running,
// so their whole history is new to us.
const APP_START_MS = Date.now();

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

// If true, a log file that already existed when the app started (and has no
// saved read position) is read from its current end: its history is skipped.
// Log files created while the app runs are always read from byte 0.
const SKIP_BACKLOG_ON_STARTUP = true;

if (!fs.existsSync(logpath)) fs.mkdirSync(logpath, { recursive: true });
if (!fs.existsSync(configDir)) fs.mkdirSync(configDir, { recursive: true });

const cursorPath = path.join(configDir, "log-cursor.json");

let currentLogFile = null;
let currentFileId = null; // identity of currentLogFile, to notice a replaced file
let lastReadPosition = 0;
let isFirstFileSelection = true;
let discardingOversizedLine = false; // inside a line longer than a whole chunk

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
const BLACKLIST_RETRY_MS = 30 * 1000; // retry this often until a list is loaded
const BLACKLIST_FETCH_TIMEOUT_MS = 10 * 1000;
const blacklistCachePath = path.join(configDir, "blacklist-cache.json");

// id -> the full blacklist entry ({ id, name, comment, ... }), so we can tell
// the user WHY an instance is blocked
let blockedWorlds = new Map();
let blockedGroups = new Map();
let blacklistEtag = null; // ETag of the last blacklist we downloaded successfully

// Fail closed: nothing is read or sent until a valid blacklist (downloaded or
// cached) has been loaded at least once.
let blacklistLoaded = false;

// What instance the player is currently in, and whether it is blocked
let currentWorldId = null;
let currentGroupId = null;
let destinationKnown = false; // events are ignored until a destination is seen
let isBlocked = false;
let blockedKey = null; // e.g. "group:grp_..." so we notice a change of blocked instance

/**
 * File format: { "world": [ { "id": "wrld_...", "name": "...", "comment": "..." }, ... ],
 *                "group": [ { "id": "grp_...",  "name": "...", "comment": "..." }, ... ] }
 * An optional "reason" field is shown to the user instead of "comment".
 * Plain strings are accepted in the arrays as well.
 * Both "world" and "group" must be arrays, otherwise this throws and the
 * lists currently in use stay untouched.
 */
function parseBlacklist(data) {
  if (!data || !Array.isArray(data.world) || !Array.isArray(data.group)) {
    throw new Error('Blacklist must contain "world" and "group" arrays');
  }

  const toMap = (list) => {
    const map = new Map();
    for (const entry of list) {
      const id = typeof entry === "string" ? entry : entry?.id;
      if (typeof id !== "string" || !id.trim()) continue;
      map.set(id.trim(), entry && typeof entry === "object" ? entry : {});
    }
    return map;
  };

  return { worlds: toMap(data.world), groups: toMap(data.group) };
}

function applyBlacklistData(data) {
  const { worlds, groups } = parseBlacklist(data); // throws before any change
  blockedWorlds = worlds;
  blockedGroups = groups;
  blacklistLoaded = true;
}

function loadBlacklistCache() {
  try {
    if (!fs.existsSync(blacklistCachePath)) return;
    applyBlacklistData(JSON.parse(fs.readFileSync(blacklistCachePath, "utf8")));
    main.log(
      `Loaded cached blacklist (${blockedWorlds.size} worlds, ${blockedGroups.size} groups)`,
      "info",
      "main_log",
    );
  } catch (err) {
    reportError(`Failed reading blacklist cache: ${err.message}`);
  }
}

function updateBlockedState() {
  let type = null;
  let id = null;
  let entry = null;

  if (currentWorldId && blockedWorlds.has(currentWorldId)) {
    type = "world";
    id = currentWorldId;
    entry = blockedWorlds.get(id);
  } else if (currentGroupId && blockedGroups.has(currentGroupId)) {
    type = "group";
    id = currentGroupId;
    entry = blockedGroups.get(id);
  }

  const key = id ? `${type}:${id}` : null;
  if (key === blockedKey) return; // nothing changed

  blockedKey = key;
  isBlocked = key !== null;

  if (isBlocked) {
    const name = entry?.name ? ` "${entry.name}"` : "";
    const reason = entry?.reason || entry?.comment;
    main.log(
      `Blacklisted ${type}${name} (${id})${reason ? `: ${reason}` : ""}. Not sending data while in this instance.`,
      "warn",
      "main_log",
    );
  } else {
    main.log("Left blacklisted instance: sending resumed", "info", "main_log");
  }
}

/**
 * Downloads the blacklist. Resolves to { text, etag }, or null when the
 * server says nothing changed (304 Not Modified).
 */
async function fetchBlacklist() {
  const headers = {};
  if (blacklistEtag) headers["If-None-Match"] = blacklistEtag;

  const res = await fetch(BLACKLIST_URL, {
    headers,
    cache: "no-store",
    signal: AbortSignal.timeout(BLACKLIST_FETCH_TIMEOUT_MS),
  });

  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);

  return { text: await res.text(), etag: res.headers.get("etag") };
}

async function saveBlacklistCache(text) {
  try {
    await fs.promises.writeFile(blacklistCachePath, text);
  } catch (err) {
    // Not fatal: the lists are already active in memory
    reportError(`Failed writing blacklist cache: ${err.message}`);
  }
}

async function refreshBlacklist() {
  try {
    const result = await fetchBlacklist();
    if (!result) return; // unchanged since the last download

    // Throws on bad JSON or a wrong shape, keeping the last good lists
    applyBlacklistData(JSON.parse(result.text));
    blacklistEtag = result.etag; // only remembered after a good parse

    // Apply to the instance the player is in right now, before anything slow
    updateBlockedState();

    main.log(
      `Blacklist updated (${blockedWorlds.size} worlds, ${blockedGroups.size} groups)`,
      "info",
      "main_log",
    );

    await saveBlacklistCache(result.text);
  } catch (err) {
    // Keep using the last good lists (in memory or from the cache file)
    reportError(`Failed refreshing blacklist: ${err.message}`, true);
  }
}

/**
 * Refreshes every BLACKLIST_REFRESH_MS, or every BLACKLIST_RETRY_MS while no
 * valid list has been loaded yet (reading stays paused until one is).
 */
function scheduleBlacklistRefresh() {
  const delay = blacklistLoaded ? BLACKLIST_REFRESH_MS : BLACKLIST_RETRY_MS;
  setTimeout(async () => {
    await refreshBlacklist();
    scheduleBlacklistRefresh();
  }, delay);
}

function resetInstanceState() {
  currentWorldId = null;
  currentGroupId = null;
  destinationKnown = false;
  updateBlockedState();
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
  destinationKnown = true;
  updateBlockedState();
}

// ---------------------------------------------------------------------------
// Log file position (so a restart resumes instead of skipping or replaying)
// ---------------------------------------------------------------------------

function fileIdentity(stats) {
  return `${stats.dev}:${stats.ino}:${Math.round(stats.birthtimeMs)}`;
}

function loadCursor() {
  try {
    return JSON.parse(fs.readFileSync(cursorPath, "utf8"));
  } catch {
    return null;
  }
}

async function saveCursor() {
  try {
    await fs.promises.writeFile(
      cursorPath,
      JSON.stringify({
        file: currentLogFile,
        id: currentFileId,
        position: lastReadPosition,
      }),
    );
  } catch (err) {
    reportError(`Failed saving log position: ${err.message}`);
  }
}

/**
 * Moves a byte offset back to the start of the line it falls in, so a line
 * that is only partly written is read again once it is complete.
 */
async function alignToLineStart(file, offset) {
  if (offset === 0) return 0;

  const length = Math.min(offset, 64 * 1024);
  const buffer = Buffer.allocUnsafe(length);
  const handle = await fs.promises.open(file, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, offset - length);
    const newline = buffer.lastIndexOf(0x0a, bytesRead - 1);
    return newline === -1 ? offset : offset - bytesRead + newline + 1;
  } finally {
    await handle.close();
  }
}

function lastDestinationIn(buffer) {
  const lines = buffer.toString("utf8").split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(DESTINATION_REGEX);
    if (match) return match;
  }
  return null;
}

/**
 * Scans backwards from `endPos` (a line start) for the most recent
 * "Destination set" line, however far back it is. Used when starting
 * mid-session so we know which instance the player is already in.
 * Only complete lines are matched: the first line of each block may continue
 * from the previous block, so it is carried over and joined before matching.
 */
async function findLastDestination(file, endPos) {
  const BLOCK = 8 * 1024 * 1024;
  const MAX_CARRY = 64 * 1024 * 1024; // give up on absurdly long single lines

  const handle = await fs.promises.open(file, "r");
  try {
    let end = endPos;
    let carry = Buffer.alloc(0); // start of a line that began in a later block

    while (end > 0) {
      const start = Math.max(0, end - BLOCK);
      const block = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await handle.read(block, 0, end - start, start);
      const data = Buffer.concat([block.subarray(0, bytesRead), carry]);

      let complete = data;
      carry = Buffer.alloc(0);

      if (start > 0) {
        // Bytes before the first newline may be the tail of a line that
        // begins in an earlier block, so they are not matched yet.
        const firstNewline = data.indexOf(0x0a);
        if (firstNewline === -1) {
          if (data.length <= MAX_CARRY) carry = data;
          end = start;
          continue;
        }
        carry = data.subarray(0, firstNewline);
        complete = data.subarray(firstNewline + 1);
      }

      const match = lastDestinationIn(complete);
      if (match) return match;
      end = start;
    }
  } finally {
    await handle.close();
  }
  return null;
}

// ---------------------------------------------------------------------------

/**
 * Where to start reading a log file we have just selected.
 */
async function resolveStartPosition(file, stats, isStartup) {
  // A log VRChat creates while we run: read it all
  if (!isStartup) return 0;

  // Resume where the previous run stopped, if it is still the same file
  const saved = loadCursor();
  if (
    saved &&
    saved.file === file &&
    saved.id === fileIdentity(stats) &&
    Number.isInteger(saved.position) &&
    saved.position <= stats.size
  ) {
    return saved.position;
  }

  // VRChat started after us: nothing in this file is old
  if (stats.birthtimeMs >= APP_START_MS) return 0;

  if (!SKIP_BACKLOG_ON_STARTUP) return 0;
  return alignToLineStart(file, stats.size);
}

/**
 * Selects a log file. Everything that can fail runs first; the module state
 * is only changed afterwards, so a failure is simply retried on the next poll.
 */
async function selectLogFile(latestLogFile) {
  const stats = await fs.promises.stat(latestLogFile);
  const position = await resolveStartPosition(
    latestLogFile,
    stats,
    isFirstFileSelection,
  );
  const lastDestination =
    position > 0 ? await findLastDestination(latestLogFile, position) : null;

  currentLogFile = latestLogFile;
  currentFileId = fileIdentity(stats);
  lastReadPosition = position;
  discardingOversizedLine = false;
  isFirstFileSelection = false;

  // New log = new VRChat session: forget the previous instance
  resetInstanceState();
  if (lastDestination) handleDestination(lastDestination);

  await saveCursor();
  main.log(`Switching to new log file: ${currentLogFile}`, "info", "main_log");
}

async function findLatestLogFile() {
  const logDirectory = await getConfig("Directories.LogDirectory");

  if (!logDirectory) {
    reportError("Log directory path is missing or null.");
    return null;
  }

  const logFileNames = (await fs.promises.readdir(logDirectory)).filter(
    (name) => name?.startsWith("output_log"),
  );
  if (logFileNames.length === 0) return null;

  logFileNames.sort();
  return path.join(logDirectory, logFileNames[logFileNames.length - 1]);
}

async function checkForNewFiles() {
  try {
    const latestLogFile = await findLatestLogFile();
    if (latestLogFile && latestLogFile !== currentLogFile) {
      await selectLogFile(latestLogFile);
    }
  } catch (err) {
    reportError(`Failed reading directory structures: ${err.message}`, true);
  }
}

/**
 * Reads up to READ_CHUNK_BYTES of new data and only consumes whole lines.
 * Returns [completeLines, newLastReadPosition]. The position always lands
 * right after a newline (or after discarded bytes of an oversized line), so
 * no partial-line buffer is needed.
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
  const data = buffer.subarray(0, bytesRead);

  // Inside an oversized line: throw bytes away until its newline is reached
  let start = 0;
  if (discardingOversizedLine) {
    const newline = data.indexOf(0x0a);
    if (newline === -1) return [[], lastReadPosition + bytesRead];
    discardingOversizedLine = false;
    start = newline + 1;
  }

  const lastNewline = data.lastIndexOf(0x0a);

  if (lastNewline < start) {
    if (start === 0 && bytesRead === READ_CHUNK_BYTES) {
      // A single line longer than the whole chunk: skip it, including every
      // later chunk of it, until its newline.
      reportError(
        `Skipped a log line longer than ${READ_CHUNK_BYTES} bytes.`,
        true,
      );
      discardingOversizedLine = true;
      return [[], lastReadPosition + bytesRead];
    }
    // Incomplete last line; wait for more data.
    return [[], lastReadPosition + start];
  }

  const text = data.toString("utf8", start, lastNewline);
  // VRChat logs on Windows use \r\n; strip the \r so it never ends up in a match
  return [text.split(/\r?\n/), lastReadPosition + lastNewline + 1];
}

/**
 * Handles a "Switching <user> to avatar <name>" line.
 */
function processSwitchLine(log) {
  const switchMatch = log.match(SWITCH_REGEX);
  if (!switchMatch) return;

  const username = switchMatch[1].trim();
  const avatarName = switchMatch[2].trim();

  if (!username || !avatarName) {
    // Never send an empty name to the API (it answers 400)
    main.log(`Skipped switch line with empty name: ${log}`, "warn", "main_log");
    return;
  }

  main.log(`User ${username} switching to ${avatarName}`, "info", "main_log");
  enqueueSwitchStatus(username, avatarName);
}

/**
 * Handles lines that contain an avatar ID (API URL or asset bundle download).
 */
async function processAvatarLine(log) {
  const avatarIdMatch =
    log.match(AVATAR_API_REGEX) || log.match(ASSET_BUNDLE_REGEX);
  if (!avatarIdMatch) return;

  const avatarId = avatarIdMatch[1];

  const isNewAvatarId = await avatar_id_store.checkAndMark(avatarId);
  if (!isNewAvatarId) return;

  // A blacklist refresh may have blocked this instance while we were waiting
  if (isBlocked) return;

  main.log(`Found avatar ID: ${avatarId}`, "info", "main_log");
  enqueueLogAvatar(avatarId, "system_log");
}

/**
 * Routes one log line to the right handler.
 */
async function processLogLine(log) {
  // Destination lines are always processed: they decide whether
  // the instance the player is in is blacklisted.
  const destMatch = log.match(DESTINATION_REGEX);
  if (destMatch) {
    handleDestination(destMatch);
    return;
  }

  // Which instance this line belongs to is not known yet: ignore it
  if (!destinationKnown) return;

  // In a blacklisted world/group: skip switch and avatar handling.
  // (Avatar IDs are NOT marked as seen, so they are still logged
  // later if the player sees them in an allowed instance.)
  if (isBlocked) return;

  processSwitchLine(log);
  await processAvatarLine(log);
}

/**
 * Reads and processes one chunk of new log data.
 * Returns true if more data is waiting (so the caller can skip its sleep).
 */
async function readAndProcessNewLogs(fileSize) {
  const prevPosition = lastReadPosition;
  const [newLogs, newLastReadPosition] = await readNewLogs(fileSize);

  for (const log of newLogs) {
    if (log) await processLogLine(log);
  }

  lastReadPosition = newLastReadPosition;
  if (lastReadPosition !== prevPosition) await saveCursor();

  // Still catching up on a backlog: skip the sleep and read the next chunk
  return lastReadPosition > prevPosition && lastReadPosition < fileSize;
}

/**
 * The selected log file was replaced or truncated: start it over.
 */
async function restartLogFile(stats) {
  currentFileId = fileIdentity(stats);
  lastReadPosition = 0;
  discardingOversizedLine = false;
  resetInstanceState();
  await saveCursor();
}

/**
 * One monitor iteration. Returns true if more data is waiting.
 */
async function pollLogFile() {
  await checkForNewFiles();

  if (!currentLogFile) {
    main.log(
      "No log file selected. Waiting for a new log file...",
      "info",
      "main_log",
    );
    return false;
  }

  // Nothing is read (so nothing is skipped) until a blacklist is available
  if (!blacklistLoaded) return false;

  const stats = await fs.promises.stat(currentLogFile);

  // Replaced (even if it has already grown past our position) or truncated
  if (fileIdentity(stats) !== currentFileId || stats.size < lastReadPosition) {
    await restartLogFile(stats);
    return false;
  }

  if (stats.size === lastReadPosition) return false;

  return readAndProcessNewLogs(stats.size);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A failed poll (file deleted mid-read, transient I/O error) is retried on the
// next loop instead of stopping the monitor for good.
async function pollSafely() {
  try {
    return await pollLogFile();
  } catch (err) {
    reportError(`Log poll failed, retrying: ${err.message}`, true);
    return false;
  }
}

(async function monitorAndSend() {
  try {
    await new Promise((resolve) => app.once("db-ready", resolve));

    // Use the last saved blacklist right away, then fetch a fresh copy
    loadBlacklistCache();
    await refreshBlacklist();
    scheduleBlacklistRefresh();

    while (true) {
      const hasMore = await pollSafely();
      if (!hasMore) await sleep(1000);
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
