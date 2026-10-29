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
// Hex of the bytes just before lastReadPosition. If they change, the file was
// rewritten under the same identity (truncated and regrown between two polls).
// null = not known (could not be read); it is learned again on the next poll.
let lastAnchor = "";

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
 * Both "world" and "group" must be arrays and every entry needs a valid id
 * ("wrld_..." / "grp_..."), otherwise this throws and the lists currently in
 * use stay untouched (a malformed list is never treated as "nothing blocked").
 */
const BLACKLIST_ID_PATTERNS = {
  world: /^wrld_[a-f0-9-]+$/i,
  group: /^grp_[a-f0-9-]+$/i,
};

/**
 * Every entry must have a well-formed id. One bad entry makes the whole list
 * invalid (it throws), because skipping it would silently let that world or
 * group through. Keys are lower-cased: VRChat writes ids in lower case.
 */
function parseBlacklistEntries(list, kind) {
  const map = new Map();
  list.forEach((entry, index) => {
    const id = typeof entry === "string" ? entry : entry?.id;
    if (
      typeof id !== "string" ||
      !BLACKLIST_ID_PATTERNS[kind].test(id.trim())
    ) {
      throw new Error(
        `Blacklist ${kind}[${index}] has a missing or malformed id`,
      );
    }
    map.set(
      id.trim().toLowerCase(),
      entry && typeof entry === "object" ? entry : {},
    );
  });
  return map;
}

function parseBlacklist(data) {
  if (!data || !Array.isArray(data.world) || !Array.isArray(data.group)) {
    throw new Error('Blacklist must contain "world" and "group" arrays');
  }

  return {
    worlds: parseBlacklistEntries(data.world, "world"),
    groups: parseBlacklistEntries(data.group, "group"),
  };
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

/**
 * The blacklist entry that blocks an instance, or null. Used both for the
 * instance the player is in now and, when a request is about to be sent or
 * retried, for the instance the event came from.
 */
function findBlock(worldId, groupId) {
  const worldKey = worldId?.toLowerCase();
  const groupKey = groupId?.toLowerCase();

  if (worldKey && blockedWorlds.has(worldKey)) {
    return { type: "world", id: worldId, entry: blockedWorlds.get(worldKey) };
  }
  if (groupKey && blockedGroups.has(groupKey)) {
    return { type: "group", id: groupId, entry: blockedGroups.get(groupKey) };
  }
  return null;
}

/**
 * Asked by the request queues right before a request is dispatched and before
 * every retry. Re-reads the CURRENT blacklist, so a refresh that blocks the
 * instance cancels requests that were already queued or waiting to retry.
 */
function canSendFor(ctx) {
  return () => blacklistLoaded && !findBlock(ctx.worldId, ctx.groupId);
}

function updateBlockedState() {
  const block = findBlock(currentWorldId, currentGroupId);
  const type = block?.type ?? null;
  const id = block?.id ?? null;
  const entry = block?.entry ?? null;

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

// Events that were read from the log but are not finished yet. Each one
// remembers the file it came from, the byte offset where its line starts and
// the instance (world/group) it happened in. They are saved together with the
// log position, so after a restart every unfinished event is read again from
// its own line (replayRestoredDeliveries), whichever log file it was in and
// wherever the saved position has moved to since.
const MAX_PERSISTED_DELIVERIES = 1000;
const MAX_REPLAYS = 5; // restarts an event may be replayed across
const MAX_REPLAY_ERRORS = 5; // failed replay attempts before it is given up
const MAX_REPLAY_LINE_BYTES = 1024 * 1024;
const pendingDeliveries = new Map();
let nextDeliveryId = 0;

function restoreDelivery(raw) {
  if (!raw || typeof raw !== "object") return null;
  if (typeof raw.file !== "string" || typeof raw.fileId !== "string") {
    return null;
  }
  if (!Number.isInteger(raw.offset) || raw.offset < 0) return null;
  if (raw.kind !== "avatar" && raw.kind !== "switch") return null;

  const replays = Number.isInteger(raw.replays) ? raw.replays : 0;
  if (replays >= MAX_REPLAYS) return null;

  return {
    file: raw.file,
    fileId: raw.fileId,
    offset: raw.offset,
    kind: raw.kind,
    worldId: typeof raw.worldId === "string" ? raw.worldId : null,
    groupId: typeof raw.groupId === "string" ? raw.groupId : null,
    status: raw.status === "rejected" ? "rejected" : "inflight",
    replays,
    rejectRetried: raw.rejectRetried === true,
    restored: true, // not replayed yet in this run
    replayErrors: 0,
  };
}

function restorePendingDeliveries(saved) {
  if (!saved || !Array.isArray(saved.pending)) return;

  for (const raw of saved.pending.slice(-MAX_PERSISTED_DELIVERIES)) {
    const entry = restoreDelivery(raw);
    if (!entry) continue;

    // Still ahead of the saved position in the same file: reading on from the
    // saved position meets this line again, so replaying it would be a copy.
    if (
      entry.file === saved.file &&
      entry.fileId === saved.id &&
      Number.isInteger(saved.position) &&
      entry.offset >= saved.position
    ) {
      continue;
    }
    pendingDeliveries.set(nextDeliveryId++, entry);
  }
}

restorePendingDeliveries(loadCursor());

function serializeDeliveries() {
  return [...pendingDeliveries.values()].map((e) => ({
    file: e.file,
    fileId: e.fileId,
    offset: e.offset,
    kind: e.kind,
    worldId: e.worldId ?? null,
    groupId: e.groupId ?? null,
    status: e.status,
    replays: e.replays ?? 0,
    rejectRetried: e.rejectRetried === true,
  }));
}

// Saves are queued one after another so an older write can never land last.
let cursorSaveChain = Promise.resolve();

function saveCursor() {
  cursorSaveChain = cursorSaveChain.then(async () => {
    try {
      // Write a temp file, then rename it over the real one: a crash in the
      // middle can never leave a half-written (unreadable) position behind.
      // Position, oversized-line state and anchor are read together here, so
      // they always describe the same moment.
      const tempPath = `${cursorPath}.tmp`;
      await fs.promises.writeFile(
        tempPath,
        JSON.stringify({
          file: currentLogFile,
          id: currentFileId,
          position: lastReadPosition,
          discarding: discardingOversizedLine,
          anchor: typeof lastAnchor === "string" ? lastAnchor : undefined,
          pending: serializeDeliveries(),
        }),
      );
      await fs.promises.rename(tempPath, cursorPath);
    } catch (err) {
      reportError(`Failed saving log position: ${err.message}`);
    }
  });
  return cursorSaveChain;
}

const DELIVERY_RETRY_MIN_MS = 30 * 1000;
const DELIVERY_RETRY_MAX_MS = 5 * 60 * 1000;

/**
 * Delivers an avatar ID and resolves once it is no longer outstanding in this
 * session: "success", "reject" (the server refused it on its own), "blocked"
 * (its instance was blacklisted before it was sent), "superseded" (a later
 * sighting took over) or "ignored". A delivery that fails even after the
 * queue's own retries (server down, no network) is tried again with a growing
 * pause, and stays pending until it has really been delivered.
 * `canSend` is rechecked before every dispatch and retry.
 */
async function deliverAvatar(avatarId, canSend) {
  let pause = DELIVERY_RETRY_MIN_MS;
  let outcome = await enqueueLogAvatar(avatarId, { canSend });

  while (outcome === "fail" || outcome === "unsaved") {
    await sleep(pause);
    pause = Math.min(pause * 2, DELIVERY_RETRY_MAX_MS);

    if (outcome === "unsaved") {
      // The server has the avatar but its ID has not reached the disk yet:
      // try to save it again (re-sending it would not help).
      try {
        await avatar_id_store.flushAll();
        return "success";
      } catch (err) {
        reportError(`Saving avatar IDs failed again: ${err.message}`);
        continue;
      }
    }

    // The instance may have been blacklisted while we waited. The failure
    // already unmarked the ID, so nothing needs to be released.
    if (!canSend()) return "blocked";

    // The failure unmarked the ID. Mark it again for the retry; if that says
    // it is already marked, a later sighting of the same ID is handling it.
    if (!(await avatar_id_store.checkAndMark(avatarId))) return "superseded";
    outcome = await enqueueLogAvatar(avatarId, { canSend });
  }

  return outcome;
}

// username -> number of its newest switch delivery. A retry of an older status
// is dropped once a newer one exists, so it can never overwrite it.
const latestSwitchByUser = new Map();
let switchCounter = 0;

/**
 * Delivers a switch status and resolves with "success", "blocked" or
 * "superseded". A failed request is retried with a growing pause and the event
 * stays pending until it has really been delivered.
 */
async function deliverSwitch(username, avatarName, canSend) {
  const mine = ++switchCounter;
  latestSwitchByUser.set(username, mine);

  try {
    let pause = DELIVERY_RETRY_MIN_MS;
    let outcome = await enqueueSwitchStatus(username, avatarName, { canSend });

    while (outcome === "fail") {
      await sleep(pause);
      pause = Math.min(pause * 2, DELIVERY_RETRY_MAX_MS);

      if (latestSwitchByUser.get(username) !== mine) return "superseded";
      outcome = await enqueueSwitchStatus(username, avatarName, { canSend });
    }
    return outcome;
  } finally {
    if (latestSwitchByUser.get(username) === mine) {
      latestSwitchByUser.delete(username);
    }
  }
}

/**
 * Remembers an event until its request is really finished, and saves it with
 * the log position meanwhile. Settled outcomes remove it. A request the server
 * refused on its own stays saved (once) so it is tried again after a restart,
 * and so does one whose delivery threw: unsuccessful outcomes are never
 * dropped just because the promise finished.
 */
function trackDelivery(entry, delivery) {
  const key = nextDeliveryId++;
  pendingDeliveries.set(key, entry);

  Promise.resolve(delivery)
    .then((outcome) => {
      if (outcome === "reject" && !entry.rejectRetried) {
        entry.status = "rejected";
        return;
      }
      pendingDeliveries.delete(key);
    })
    .catch((err) =>
      reportError(
        `Delivery failed (kept, replayed after a restart): ${err.message}`,
      ),
    )
    .finally(() => saveCursor());
}

const ANCHOR_BYTES = 64;

/**
 * The bytes just before `position`, as hex ("" at the very start).
 */
async function readAnchor(file, position) {
  if (position <= 0) return "";

  const length = Math.min(position, ANCHOR_BYTES);
  const buffer = Buffer.allocUnsafe(length);
  const handle = await fs.promises.open(file, "r");
  try {
    const { bytesRead } = await handle.read(
      buffer,
      0,
      length,
      position - length,
    );
    return buffer.subarray(0, bytesRead).toString("hex");
  } finally {
    await handle.close();
  }
}

/**
 * Reads the line that starts at `offset`. Resolves to null when it cannot be
 * found any more (file gone or replaced, line not complete or too long).
 */
async function readLineAt(file, fileId, offset) {
  let stats;
  try {
    stats = await fs.promises.stat(file);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
  if (fileIdentity(stats) !== fileId || offset >= stats.size) return null;

  const length = Math.min(MAX_REPLAY_LINE_BYTES, stats.size - offset);
  const buffer = Buffer.allocUnsafe(length);
  const handle = await fs.promises.open(file, "r");
  try {
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    const data = buffer.subarray(0, bytesRead);
    const newline = data.indexOf(0x0a);
    if (newline === -1) return null;
    const end =
      newline > 0 && data[newline - 1] === 0x0d ? newline - 1 : newline;
    return data.toString("utf8", 0, end);
  } finally {
    await handle.close();
  }
}

/**
 * Moves a byte offset back to the start of the line it falls in, so a line
 * that is only partly written is read again once it is complete. Scans back
 * as far as one read chunk, however long the partial line is. Resolves to
 * { position, discarding }: when even that far back there is no newline, the
 * line is longer than a chunk (readNewLogs would skip it), so the position is
 * kept and the rest of the line is flagged to be discarded.
 */
async function alignToLineStart(file, offset) {
  if (offset === 0) return { position: 0, discarding: false };

  const BLOCK = 64 * 1024;
  const floor = Math.max(0, offset - READ_CHUNK_BYTES);
  const handle = await fs.promises.open(file, "r");
  try {
    let end = offset;
    while (end > floor) {
      const start = Math.max(floor, end - BLOCK);
      const buffer = Buffer.allocUnsafe(end - start);
      const { bytesRead } = await handle.read(buffer, 0, end - start, start);
      const newline =
        bytesRead > 0 ? buffer.lastIndexOf(0x0a, bytesRead - 1) : -1;
      if (newline !== -1)
        return { position: start + newline + 1, discarding: false };
      end = start;
    }
  } finally {
    await handle.close();
  }

  // No newline all the way back to the start of the file: that is line one
  if (floor === 0) return { position: 0, discarding: false };
  return { position: offset, discarding: true };
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
 * Resolves to { position, discarding } (discarding: the position is inside a
 * line that is longer than a chunk and is being skipped).
 */
async function resolveStartPosition(file, stats, isStartup) {
  // A log VRChat creates while we run: read it all
  if (!isStartup) return { position: 0, discarding: false };

  // Resume where the previous run stopped, if it is still the same file
  const saved = loadCursor();
  if (
    saved &&
    saved.file === file &&
    saved.id === fileIdentity(stats) &&
    Number.isInteger(saved.position) &&
    saved.position <= stats.size
  ) {
    // The bytes before the position must still be the ones we saw: if not,
    // the file was rewritten under the same identity.
    const anchor = await readAnchor(file, saved.position);
    if (typeof saved.anchor !== "string" || saved.anchor === anchor) {
      return {
        position: saved.position,
        discarding: saved.discarding === true,
      };
    }
  }

  // VRChat started after us: nothing in this file is old
  if (stats.birthtimeMs >= APP_START_MS)
    return { position: 0, discarding: false };

  if (!SKIP_BACKLOG_ON_STARTUP) return { position: 0, discarding: false };
  return alignToLineStart(file, stats.size);
}

/**
 * Selects a log file. Everything that can fail runs first; the module state
 * is only changed afterwards, so a failure is simply retried on the next poll.
 */
async function selectLogFile(latestLogFile) {
  const stats = await fs.promises.stat(latestLogFile);
  const { position, discarding } = await resolveStartPosition(
    latestLogFile,
    stats,
    isFirstFileSelection,
  );
  const lastDestination =
    position > 0 ? await findLastDestination(latestLogFile, position) : null;
  const anchor = await readAnchor(latestLogFile, position);

  currentLogFile = latestLogFile;
  currentFileId = fileIdentity(stats);
  lastReadPosition = position;
  discardingOversizedLine = discarding;
  lastAnchor = anchor;
  isFirstFileSelection = false;

  // New log = new VRChat session: forget the previous instance
  resetInstanceState();
  if (lastDestination) handleDestination(lastDestination);

  // Events still in flight from the previous log file stay in
  // pendingDeliveries, so this save keeps them.
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
 * Returns { lines, position, discarding }: each line is { text, offset, end }
 * (offset = where the line starts, end = just after its newline), position is
 * where reading continues and discarding says whether that position is inside
 * an oversized line that is being skipped. Nothing is changed here: the
 * caller applies position and discarding together, so a saved cursor can
 * never hold one without the other.
 * The position always lands right after a newline (or after discarded bytes
 * of an oversized line), so no partial-line buffer is needed.
 */
async function readNewLogs(fileSize) {
  const unchanged = {
    lines: [],
    position: lastReadPosition,
    discarding: discardingOversizedLine,
  };

  const bytesAvailable = fileSize - lastReadPosition;
  if (bytesAvailable <= 0) return unchanged;

  const toRead = Math.min(bytesAvailable, READ_CHUNK_BYTES);
  const buffer = Buffer.allocUnsafe(toRead);

  const handle = await fs.promises.open(currentLogFile, "r");
  let bytesRead;
  try {
    ({ bytesRead } = await handle.read(buffer, 0, toRead, lastReadPosition));
  } finally {
    await handle.close();
  }

  if (bytesRead === 0) return unchanged;
  const data = buffer.subarray(0, bytesRead);

  // Inside an oversized line: throw bytes away until its newline is reached
  let start = 0;
  if (discardingOversizedLine) {
    const newline = data.indexOf(0x0a);
    if (newline === -1) {
      return {
        lines: [],
        position: lastReadPosition + bytesRead,
        discarding: true,
      };
    }
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
      return {
        lines: [],
        position: lastReadPosition + bytesRead,
        discarding: true,
      };
    }
    // Incomplete last line; wait for more data.
    return { lines: [], position: lastReadPosition + start, discarding: false };
  }

  const lines = [];
  let lineStart = start;
  while (lineStart <= lastNewline) {
    const newline = data.indexOf(0x0a, lineStart);
    // VRChat logs on Windows use \r\n; strip the \r so it never ends up in a match
    const lineEnd =
      newline > lineStart && data[newline - 1] === 0x0d ? newline - 1 : newline;

    if (lineEnd > lineStart) {
      lines.push({
        text: data.toString("utf8", lineStart, lineEnd),
        offset: lastReadPosition + lineStart,
        end: lastReadPosition + newline + 1,
      });
    }
    lineStart = newline + 1;
  }

  return {
    lines,
    position: lastReadPosition + lastNewline + 1,
    discarding: false,
  };
}

/**
 * What is needed to deliver (and later replay) the event on one line.
 */
function eventContext(offset) {
  return {
    file: currentLogFile,
    fileId: currentFileId,
    offset,
    worldId: currentWorldId,
    groupId: currentGroupId,
    replays: 0,
    rejectRetried: false,
  };
}

/**
 * Handles a "Switching <user> to avatar <name>" line.
 */
function processSwitchLine(log, ctx) {
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
  trackDelivery(
    { ...ctx, kind: "switch", status: "inflight" },
    deliverSwitch(username, avatarName, canSendFor(ctx)),
  );
}

/**
 * Handles lines that contain an avatar ID (API URL or asset bundle download).
 * If the blacklist blocks the instance after the ID was marked, the request
 * queue cancels the delivery before it is sent and releases the ID (canSend).
 */
async function processAvatarLine(log, ctx) {
  const avatarIdMatch =
    log.match(AVATAR_API_REGEX) || log.match(ASSET_BUNDLE_REGEX);
  if (!avatarIdMatch) return;

  const avatarId = avatarIdMatch[1];

  const isNewAvatarId = await avatar_id_store.checkAndMark(avatarId);
  if (!isNewAvatarId) return;

  main.log(`Found avatar ID: ${avatarId}`, "info", "main_log");
  trackDelivery(
    { ...ctx, kind: "avatar", status: "inflight" },
    deliverAvatar(avatarId, canSendFor(ctx)),
  );
}

/**
 * Routes one log line to the right handler.
 */
async function processLogLine(log, offset) {
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

  // The avatar handler is the only one that can fail (it reads the avatar ID
  // store), so it goes first: if it throws, nothing was started for this line
  // and the line can simply be read again without duplicating a request.
  const ctx = eventContext(offset);
  await processAvatarLine(log, ctx);
  processSwitchLine(log, ctx);
}

/**
 * Makes `position` the place reading continues from. The anchor is read
 * before anything is assigned and everything is then set in one step.
 */
async function commitPosition(position, discarding) {
  let anchor = null;
  try {
    anchor = await readAnchor(currentLogFile, position);
  } catch (err) {
    reportError(`Failed reading log anchor: ${err.message}`);
  }

  lastReadPosition = position;
  discardingOversizedLine = discarding;
  lastAnchor = anchor;
  await saveCursor();
}

/**
 * Reads and processes one chunk of new log data.
 * Returns true if more data is waiting (so the caller can skip its sleep).
 * If a line fails, the position is moved up to the last line that finished
 * and the error is rethrown: the next poll starts at the failing line, so
 * lines that already started a request are not processed again.
 */
async function readAndProcessNewLogs(fileSize) {
  const prevPosition = lastReadPosition;
  const { lines, position, discarding } = await readNewLogs(fileSize);

  let committed = prevPosition;
  try {
    for (const line of lines) {
      await processLogLine(line.text, line.offset);
      committed = line.end;
    }
  } catch (err) {
    if (committed !== prevPosition) {
      try {
        await commitPosition(committed, false);
      } catch (commitErr) {
        reportError(`Failed saving partial progress: ${commitErr.message}`);
      }
    }
    throw err;
  }

  if (position !== prevPosition || discarding !== discardingOversizedLine) {
    await commitPosition(position, discarding);
  }

  // Still catching up on a backlog: skip the sleep and read the next chunk
  return lastReadPosition > prevPosition && lastReadPosition < fileSize;
}

/**
 * The selected log file was replaced, truncated or rewritten: start it over.
 */
async function restartLogFile(stats) {
  currentFileId = fileIdentity(stats);
  lastReadPosition = 0;
  discardingOversizedLine = false;
  lastAnchor = "";
  resetInstanceState();
  await saveCursor();
}

/**
 * True if the bytes just before our position are no longer the ones we read:
 * the file was truncated and grew past our position again between two polls
 * (same identity, size no smaller than the position).
 */
async function wasRewritten() {
  if (lastReadPosition === 0) return false;

  const anchor = await readAnchor(currentLogFile, lastReadPosition);
  if (lastAnchor === null) {
    lastAnchor = anchor; // never verified: trust what is there now
    return false;
  }
  return anchor !== lastAnchor;
}

/**
 * Events that were unfinished when the app last stopped (and are behind the
 * saved position, or in an older log file) are read again from their own
 * lines and delivered. Runs once the blacklist is loaded, because every
 * delivery is checked against it.
 */
async function replayDelivery(entry) {
  // The instance the event came from is blacklisted now: drop it
  if (findBlock(entry.worldId, entry.groupId)) return;

  const text = await readLineAt(entry.file, entry.fileId, entry.offset);
  if (text === null) return; // file gone or replaced: nothing to replay

  const ctx = {
    file: entry.file,
    fileId: entry.fileId,
    offset: entry.offset,
    worldId: entry.worldId,
    groupId: entry.groupId,
    replays: entry.replays + 1,
    rejectRetried: entry.rejectRetried || entry.status === "rejected",
  };

  main.log(
    `Replaying an unfinished ${entry.kind} event from an earlier session`,
    "info",
    "main_log",
  );
  if (entry.kind === "avatar") await processAvatarLine(text, ctx);
  else processSwitchLine(text, ctx);
}

async function replayRestoredDeliveries() {
  const restored = [...pendingDeliveries.entries()].filter(
    ([, entry]) => entry.restored,
  );
  if (restored.length === 0) return;

  for (const [key, entry] of restored) {
    try {
      // The replay registers its own pending entry before this one is removed
      await replayDelivery(entry);
      pendingDeliveries.delete(key);
    } catch (err) {
      entry.replayErrors += 1;
      reportError(`Replaying a saved event failed: ${err.message}`);
      if (entry.replayErrors >= MAX_REPLAY_ERRORS)
        pendingDeliveries.delete(key);
    }
  }
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

  await replayRestoredDeliveries();

  const stats = await fs.promises.stat(currentLogFile);

  // Replaced (even if it has already grown past our position), truncated, or
  // truncated and regrown past our position without changing identity
  if (
    fileIdentity(stats) !== currentFileId ||
    stats.size < lastReadPosition ||
    (await wasRewritten())
  ) {
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
