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

const axios = require("axios");
const http = require("http");
const https = require("https");
const main = require("../main");
const getConfig = require("../models/getConfig");
const { log_error } = require("../functions/logsclass.js");
const { avatar_id_store } = require("../functions/avatarIdStore.js");
const { version } = require("../package.json");

function reportError(message, emitToMain = false) {
  log_error.writeErrorToFile(message);
  if (emitToMain) {
    main.log(message, "error", "main_log");
  }
}

function isValidAvtrId(id) {
  if (typeof id !== "string") return false;
  if (!id.startsWith("avtr_")) return false;

  const uuid = id.slice(5);
  const uuidRegex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

  return uuidRegex.test(uuid);
}

function logToMain(message, type = "info") {
  main.log(message, type, "main_log");
}

const API_URL =
  "https://avatar.worldbalancer.com/v3/vrchat/avatars/store/putavatarExternalMult";

const BATCH_SIZE = 30;
const FLUSH_DELAY = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const MAX_RETRY_WAIT = 60000;
const MAX_QUEUE_SIZE = 5000;

const NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ECONNABORTED",
  "ENOTFOUND",
  "EAI_AGAIN",
]);

// "lifo": reuse the most recently used idle connection first, so connections
// the server has already closed after a quiet period are left to expire
// instead of being picked up (and failing with ECONNRESET).
const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  scheduling: "lifo",
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
  scheduling: "lifo",
});

const axiosInstance = axios.create({
  timeout: 25000,
  maxRedirects: 0, // never follow redirects: POST bodies contain user data
  httpAgent,
  httpsAgent,
  headers: {
    "Content-Type": "application/json",
    "User-Agent": `World Balancer/${version} contact@worldbalancer.com`,
    Connection: "keep-alive",
  },
});

const queue = [];
const queuedSet = new Set();

let running = false;
let workerStarting = false;

let processed = 0;
let failed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function failJob(job, reason) {
  failed++;
  if (job?.onFail) {
    try {
      job.onFail(job.avatarId, reason);
    } catch (cbErr) {
      logToMain(cbErr.message, "warn");
    }
  }
}

// The server refused this specific avatar even when sent alone, so sending it
// again would give the same answer. Unlike failJob, the ID is NOT unmarked,
// which stops it being re-sent every time it shows up in the log.
function rejectJob(job, reason) {
  failed++;
  if (job?.onReject) {
    try {
      job.onReject(job.avatarId, reason);
    } catch (cbErr) {
      logToMain(cbErr.message, "warn");
    }
  }
}

// Statuses where the server may be refusing the batch because of ONE member
// (bad request / payload / unprocessable) while accepting the others.
const MEMBER_REJECT_STATUSES = new Set([400, 413, 422]);

// Retry-After is either delta-seconds ("120") or an HTTP date
// ("Wed, 21 Oct 2026 07:28:00 GMT"). Returns milliseconds to wait, or null
// when the header is missing or unusable.
function parseRetryAfterMs(value, now = Date.now()) {
  if (Array.isArray(value)) value = value[0];
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text === "") return null;

  if (/^\d+(\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return seconds > 0 ? seconds * 1000 : null;
  }

  const dateMs = Date.parse(text);
  if (Number.isNaN(dateMs)) return null;
  const delta = dateMs - now;
  return delta > 0 ? delta : null; // a date in the past means "retry now-ish"
}

function retryWaitMs(err, attempt) {
  if (err.response?.status === 429) {
    const headers = err.response.headers || {};
    const requested = parseRetryAfterMs(
      headers["retry-after"] ?? headers["Retry-After"],
    );
    if (requested !== null) return Math.min(requested, MAX_RETRY_WAIT);
  }
  return RETRY_DELAY * (attempt + 1);
}

function isValidBatchItem(j) {
  if (!j || typeof j !== "object") {
    logToMain(
      `[Batch] Skipping invalid job object: ${JSON.stringify(j)}`,
      "warn",
    );
    return false;
  }
  if (!j.avatarId || typeof j.avatarId !== "string") {
    logToMain(`[Batch] Skipping invalid avatarId: ${j.avatarId}`, "warn");
    return false;
  }
  if (!j.userid || typeof j.userid !== "string") {
    logToMain(`[Batch] Skipping invalid userid: ${j.userid}`, "warn");
    return false;
  }
  return true;
}

function buildPayload(items) {
  return { avatars: items.map((j) => ({ id: j.avatarId, userid: j.userid })) };
}

function isRetryable(err) {
  const status = err.response?.status;
  return (
    NETWORK_ERROR_CODES.has(err.code) ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

// POSTs the payload, retrying transient errors.
// Returns { res } on success or { err } once retries are exhausted / not retryable.
async function postWithRetries(payload, validCount, totalCount) {
  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const retryLabel = attempt > 0 ? `(retry ${attempt}/${MAX_RETRIES})` : "";
    logToMain(
      `[Batch] Sending ${validCount}/${totalCount} valid avatars ${retryLabel}`,
    );

    try {
      return { res: await axiosInstance.post(API_URL, payload) };
    } catch (err) {
      lastErr = err;
      reportError(
        `[Batch] FAILED → ${validCount} avatars | code=${err.code} | status=${err.response?.status || "N/A"} | ${err.message}`,
      );

      // 400/401/403/404...: retrying or splitting won't help
      if (!isRetryable(err) || attempt === MAX_RETRIES) break;

      const waitTime = retryWaitMs(err, attempt);
      reportError(`[Batch] Retryable error. Retrying in ${waitTime}ms...`);
      await sleep(waitTime);
    }
  }

  return { err: lastErr };
}

function markBatchSucceeded(items, res) {
  processed += items.length;
  logToMain(`[Batch] SUCCESS → ${items.length} avatars | status=${res.status}`);
  for (const job of items) job.onSuccess?.(job.avatarId);
}

// Sends each item alone so one bad member can't sink the rest.
async function sendIndividually(items) {
  for (const job of items) {
    try {
      await axiosInstance.post(API_URL, buildPayload([job]));

      processed++;
      logToMain(`[Fallback] SUCCESS → ${job.avatarId}`);
      job.onSuccess?.(job.avatarId);
    } catch (e) {
      const errorMsg = e?.message || e?.code || "Unknown error";
      reportError(`[Fallback] FAILED → ${job?.avatarId} | ${errorMsg}`, true);
      if (MEMBER_REJECT_STATUSES.has(e?.response?.status)) {
        rejectJob(job, errorMsg); // this avatar itself is refused
      } else {
        failJob(job, errorMsg); // transient: let it be sent again later
      }
    }
    await sleep(100);
  }
}

// Retries are over. A 5xx, or a 400/413/422 that may come from one bad
// member, can hide items the server would accept alone, so try them one by
// one. Other errors (401/403/404/429...) affect every item equally.
async function handleBatchFailure(items, err) {
  const status = err?.response?.status;
  const serverError = status >= 500 && status <= 599;
  const memberReject = MEMBER_REJECT_STATUSES.has(status);
  const reason = err?.message || "Unknown error";

  if (!serverError && !memberReject) {
    for (const job of items) failJob(job, reason);
    return;
  }

  // A single item that was rejected has nobody to be separated from.
  if (items.length === 1) {
    if (memberReject) rejectJob(items[0], reason);
    else failJob(items[0], reason);
    return;
  }

  logToMain(
    `[Batch] ${serverError ? "Server error" : `Rejected (${status})`}. Falling back to individual sends...`,
    "warn",
  );
  await sendIndividually(items);
}

async function sendBatch(batch) {
  const validItems = batch.filter(isValidBatchItem);

  if (validItems.length === 0) {
    logToMain("[Batch] No valid items in batch! Skipping...", "warn");
    return;
  }

  const { res, err } = await postWithRetries(
    buildPayload(validItems),
    validItems.length,
    batch.length,
  );

  if (res) {
    markBatchSucceeded(validItems, res);
    return;
  }
  await handleBatchFailure(validItems, err);
}

async function worker() {
  if (running) return;

  running = true;
  workerStarting = false;

  logToMain(`[BatchQueue] STARTED | size=${queue.length}`);

  let batch = [];

  try {
    while (queue.length > 0) {
      batch = queue.splice(0, BATCH_SIZE);

      for (const job of batch) {
        queuedSet.delete(job.avatarId);
      }

      const safeBatch = batch.filter(
        (j) => j?.avatarId && isValidAvtrId(j.avatarId),
      );

      if (safeBatch.length === 0) {
        logToMain(
          `[BatchQueue] Skipped batch: 0 valid items out of ${batch.length}`,
          "warn",
        );
        continue;
      }

      await sendBatch(safeBatch);
      batch = [];
      await sleep(FLUSH_DELAY);
    }
  } catch (err) {
    reportError(`[BatchQueue] Worker crashed: ${err.message}`);
    // Jobs from the batch that was in progress must be released for retry.
    for (const job of batch) failJob(job, `worker crashed: ${err.message}`);
  } finally {
    running = false;
    logToMain("[BatchQueue] STOPPED (empty)");
    // Jobs added while the crash was unwinding still need a worker.
    if (queue.length > 0 && !workerStarting) {
      workerStarting = true;
      worker();
    }
  }
}

// Returns true when the job will get exactly one onSuccess / onReject / onFail
// callback (it was queued, or failed right away because the queue is full).
// Returns false when it was ignored (invalid, or the same avatar is already
// waiting in the queue): no callback will ever fire for it.
function enqueueAvatar(job) {
  if (!job || typeof job !== "object") return false;
  if (
    !job.avatarId ||
    typeof job.avatarId !== "string" ||
    !isValidAvtrId(job.avatarId)
  )
    return false;
  if (!job.userid || typeof job.userid !== "string") return false;

  if (queuedSet.has(job.avatarId)) return false;

  if (queue.length >= MAX_QUEUE_SIZE) {
    reportError(
      `[BatchQueue] Queue full (${queue.length}/${MAX_QUEUE_SIZE}), dropping avatarId=${job.avatarId}`,
      true,
    );
    failJob(job, "queue full"); // lets the caller unmark it so it can be retried
    return true;
  }

  queuedSet.add(job.avatarId);
  queue.push({ attempt: 1, ...job });

  if (!running && !workerStarting) {
    workerStarting = true;
    worker();
  }
  return true;
}

// Config values may be stored as JSON text (e.g. "\"1234\""); keep it a string.
let warnedUnsafeDiscordId = false;

function normalizeDiscordId(raw) {
  if (typeof raw === "bigint") raw = raw.toString();

  // A config value stored as a JSON number. Convert it to a string ID, but
  // only when the number is exact: Discord IDs have ~18 digits, more than a
  // JavaScript number holds, so a larger value was already rounded when it was
  // parsed and its digits are wrong. A wrong ID would attribute updates to
  // another user, so those are rejected (and reported once) instead.
  if (typeof raw === "number") {
    if (Number.isSafeInteger(raw) && raw > 0) return String(raw);
    if (!warnedUnsafeDiscordId) {
      warnedUnsafeDiscordId = true;
      reportError(
        'Userid.discord_id is stored as a number that cannot hold the full ID without rounding. Store it as a string (e.g. "123456789012345678").',
      );
    }
    return null;
  }

  if (typeof raw !== "string") return null;
  let value = raw.trim();
  try {
    const parsed = JSON.parse(value);
    if (typeof parsed === "string") value = parsed.trim();
  } catch {
    // plain string, keep as is
  }
  return value !== "" ? value : null;
}

// Makes every ID confirmed so far durable. Confirmations that arrive together
// (a whole batch succeeds at once) share one flush, but a flush that has
// already started is never reused: an ID confirmed after it began could
// otherwise be missing from what it writes.
let flushTail = Promise.resolve();
let flushQueued = null; // a flush that is waiting its turn and has not begun

function flushConfirmedIds() {
  if (flushQueued) return flushQueued;

  const run = flushTail.then(() => {
    flushQueued = null; // from here on, new confirmations need a new flush
    return avatar_id_store.flushAll();
  });
  flushQueued = run;
  flushTail = run.catch(() => {});
  return run;
}

/**
 * Queues an avatar ID found in the log.
 * Resolves, never rejects, once the job has settled:
 *   "success" - the server accepted it and its ID is saved to disk
 *   "unsaved" - the server accepted it but saving the ID to disk failed
 *   "reject"  - the server refused it on its own
 *   "fail"    - it could not be delivered (the ID was unmarked for a retry)
 *   "ignored" - it was invalid or already waiting in the queue
 * The caller can use this to know when the event is no longer in flight.
 * "success" is only reported after the ID is durable, so a caller that moves
 * its saved log position forward on it can never skip an ID that a crash
 * would then also have lost.
 */
async function enqueueLogAvatar(avatarId) {
  let discordId = "system_log";

  try {
    const fetchedId = normalizeDiscordId(await getConfig("Userid.discord_id"));
    if (fetchedId) discordId = fetchedId;
  } catch (err) {
    reportError(
      `Failed to look up config Userid.discord_id: ${err.message}`,
      true,
    );
  }

  return new Promise((resolve) => {
    const handled = enqueueAvatar({
      avatarId,
      userid: discordId,
      onSuccess: async (id) => {
        let outcome = "success";
        try {
          logToMain(`[LogSync] Synced extracted ID: ${id}`);
          // Only now is the ID saved to disk; until then a quit/crash just
          // means it gets sent again after restart.
          await avatar_id_store.confirm(id);
          await flushConfirmedIds();
        } catch (err) {
          reportError(
            `[LogSync] Could not save confirmed ID ${id}: ${err.message}`,
            true,
          );
          outcome = "unsaved";
        } finally {
          resolve(outcome);
        }
      },
      onReject: (id, err) => {
        try {
          // Refused by the server on its own: keep it marked for this session
          // so it is not re-sent on every sighting. It is never saved to disk
          // (unconfirmed), so it gets one fresh attempt after a restart.
          logToMain(`[LogSync] Server rejected ${id}: ${err}`, "warn");
        } finally {
          resolve("reject");
        }
      },
      onFail: (id, err) => {
        logToMain(`[LogSync] Sync error on ${id}: ${err}`, "warn");
        // Forget the ID so the next time it appears in the log it is sent again.
        Promise.resolve()
          .then(() => avatar_id_store.unmark(id))
          .catch((e) =>
            reportError(`[LogSync] unmark failed for ${id}: ${e.message}`),
          )
          .finally(() => resolve("fail"));
      },
    });

    if (!handled) resolve("ignored");
  });
}

const statsTimer = setInterval(
  () => {
    logToMain(
      `[Stats] queue=${queue.length} | processed=${processed} | failed=${failed} | running=${running ? "yes" : "no"}`,
    );
  },
  60 * 60 * 1000,
);
if (statsTimer.unref) statsTimer.unref();

/**
 * Resolves once the queue is empty and the worker is idle, or after
 * timeoutMs, whichever comes first. For "before-quit": a best-effort drain.
 * Nothing depends on it finishing, since unconfirmed IDs are not persisted.
 */
async function waitForIdle(timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (
    (running || workerStarting || queue.length > 0) &&
    Date.now() < deadline
  ) {
    await sleep(100);
  }
  return !(running || workerStarting || queue.length > 0);
}

function getQueueStats() {
  return { queue: queue.length, processed, failed, running };
}

module.exports = {
  normalizeDiscordId,
  parseRetryAfterMs,
  retryWaitMs,
  enqueueAvatar,
  enqueueLogAvatar,
  getQueueStats,
  waitForIdle,
};
