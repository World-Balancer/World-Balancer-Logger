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

const httpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 50,
  maxFreeSockets: 10,
});

const axiosInstance = axios.create({
  timeout: 25000,
  maxRedirects: 3,
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

function retryWaitMs(err, attempt) {
  const retryAfter = Number(err.response?.headers?.["retry-after"]);
  if (err.response?.status === 429 && Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, MAX_RETRY_WAIT);
  }
  return RETRY_DELAY * (attempt + 1);
}

async function sendBatch(batch) {
  const validItems = batch.filter((j) => {
    if (!j || typeof j !== "object") {
      logToMain(`[Batch] Skipping invalid job object: ${JSON.stringify(j)}`, "warn");
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
  });

  if (validItems.length === 0) {
    logToMain("[Batch] No valid items in batch! Skipping...", "warn");
    return;
  }

  const payload = {
    avatars: validItems.map((j) => ({ id: j.avatarId, userid: j.userid })),
  };

  let lastErr = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    logToMain(
      `[Batch] Sending ${validItems.length}/${batch.length} valid avatars ${attempt > 0 ? `(retry ${attempt}/${MAX_RETRIES})` : ""}`,
    );

    try {
      const res = await axiosInstance.post(API_URL, payload);

      processed += validItems.length;
      logToMain(`[Batch] SUCCESS → ${validItems.length} avatars | status=${res.status}`);

      for (const job of validItems) {
        job.onSuccess?.(job.avatarId);
      }
      return;
    } catch (err) {
      lastErr = err;
      const status = err.response?.status;
      const isNetwork = NETWORK_ERROR_CODES.has(err.code);
      const retryable = isNetwork || status === 429 || (status >= 500 && status <= 599);

      reportError(
        `[Batch] FAILED → ${validItems.length} avatars | code=${err.code} | status=${status || "N/A"} | ${err.message}`,
      );

      if (!retryable) break; // 400/401/403/404...: retrying or splitting won't help
      if (attempt === MAX_RETRIES) break;

      const waitTime = retryWaitMs(err, attempt);
      reportError(`[Batch] Retryable error. Retrying in ${waitTime}ms...`);
      await sleep(waitTime);
    }
  }

  // Retries are over. Only a 5xx suggests one bad item may be breaking the
  // batch, so only then try the items one by one.
  const status = lastErr?.response?.status;
  const serverError = status >= 500 && status <= 599;

  if (!serverError) {
    const reason = lastErr?.message || "Unknown error";
    for (const job of validItems) failJob(job, reason);
    return;
  }

  logToMain("[Batch] Server error. Falling back to individual sends...", "warn");

  for (const job of validItems) {
    try {
      await axiosInstance.post(API_URL, {
        avatars: [{ id: job.avatarId, userid: job.userid }],
      });

      processed++;
      logToMain(`[Fallback] SUCCESS → ${job.avatarId}`);
      job.onSuccess?.(job.avatarId);
    } catch (e) {
      const errorMsg = e?.message || e?.code || "Unknown error";
      reportError(`[Fallback] FAILED → ${job?.avatarId} | ${errorMsg}`, true);
      failJob(job, errorMsg);
    }
    await sleep(100);
  }
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

function enqueueAvatar(job) {
  if (!job || typeof job !== "object") return;
  if (
    !job.avatarId ||
    typeof job.avatarId !== "string" ||
    !isValidAvtrId(job.avatarId)
  )
    return;
  if (!job.userid || typeof job.userid !== "string") return;

  if (queuedSet.has(job.avatarId)) return;

  if (queue.length >= MAX_QUEUE_SIZE) {
    reportError(
      `[BatchQueue] Queue full (${queue.length}/${MAX_QUEUE_SIZE}), dropping avatarId=${job.avatarId}`,
      true,
    );
    failJob(job, "queue full"); // lets the caller unmark it so it can be retried
    return;
  }

  queuedSet.add(job.avatarId);
  queue.push({ attempt: 1, ...job });

  if (!running && !workerStarting) {
    workerStarting = true;
    worker();
  }
}

// Config values may be stored as JSON text (e.g. "\"1234\""); keep it a string.
function normalizeDiscordId(raw) {
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

  enqueueAvatar({
    avatarId,
    userid: discordId,
    onSuccess: (id) => logToMain(`[LogSync] Synced extracted ID: ${id}`),
    onFail: (id, err) => {
      logToMain(`[LogSync] Sync error on ${id}: ${err}`, "warn");
      // Forget the ID so the next time it appears in the log it is sent again.
      avatar_id_store
        .unmark(id)
        .catch((e) => reportError(`[LogSync] unmark failed for ${id}: ${e.message}`));
    },
  });
}

const statsTimer = setInterval(() => {
  logToMain(
    `[Stats] queue=${queue.length} | processed=${processed} | failed=${failed} | running=${running ? "yes" : "no"}`,
  );
}, 60 * 60 * 1000);
if (statsTimer.unref) statsTimer.unref();

function getQueueStats() {
  return { queue: queue.length, processed, failed, running };
}

module.exports = {
  enqueueAvatar,
  enqueueLogAvatar,
  getQueueStats,
};
