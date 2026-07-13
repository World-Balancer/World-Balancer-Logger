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

const BATCH_SIZE = 30;
const FLUSH_DELAY = 1000;
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000;
const MAX_QUEUE_SIZE = 5000;

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
  maxRedirects: 0,
  httpAgent,
  httpsAgent,
  headers: {
    "Content-Type": "application/json",
    "User-Agent": "World Balancer/0.0.3 contact@worldbalancer.com",
    Connection: "keep-alive",
  },
});

// ─── QUEUE STATE ─────────────────────────────────────────────
const queue = [];
const queuedSet = new Set();

let running = false;
let workerStarting = false;

let processed = 0;
let failed = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sendBatch(batch, retryCount = 0) {
  const validItems = batch.filter((j) => {
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
  });

  if (validItems.length === 0) {
    logToMain(`[Batch] ⚠️ No valid items in batch! Skipping...`, "warn");
    return;
  }

  const payload = {
    avatars: validItems.map((j) => ({
      id: j.avatarId,
      userid: j.userid,
    })),
  };

  logToMain(
    `[Batch] Sending ${validItems.length}/${batch.length} valid avatars ${retryCount > 0 ? `(retry ${retryCount}/${MAX_RETRIES})` : ""}`,
  );

  try {
    const res = await axiosInstance.post(
      "https://avatar.worldbalancer.com/v3/vrchat/avatars/store/putavatarExternalMult",
      payload,
    );

    processed += batch.length;
    logToMain(
      `[Batch] SUCCESS → ${batch.length} avatars | status=${res.status}`,
    );

    for (const job of batch) {
      job.onSuccess?.(job.avatarId);
    }
  } catch (err) {
    const isConnectionError =
      err.code === "ECONNRESET" ||
      err.code === "ECONNREFUSED" ||
      err.code === "ETIMEDOUT";

    reportError(
      `[Batch] FAILED → ${batch.length} avatars | code=${err.code} | status=${err.response?.status || "N/A"}`,
    );

    if (isConnectionError && retryCount < MAX_RETRIES) {
      const waitTime = RETRY_DELAY * (retryCount + 1);
      reportError(
        `[Batch] Connection error detected. Retrying in ${waitTime}ms...`,
      );
      await sleep(waitTime);
      return sendBatch(batch, retryCount + 1);
    }

    logToMain(`[Batch] Falling back to individual sends...`, "warn");

    for (const job of batch) {
      try {
        if (!job || typeof job !== "object" || !job.avatarId || !job.userid) {
          failed++;
          continue;
        }

        const fallbackPayload = {
          id: job.avatarId,
          userid: job.userid,
        };

        await axiosInstance.post(
          "https://avatar.worldbalancer.com/v3/vrchat/avatars/store/putavatarExternalMult",
          fallbackPayload,
        );

        processed++;
        logToMain(`[Fallback] SUCCESS → ${job.avatarId}`);
        job.onSuccess?.(job.avatarId);
      } catch (e) {
        failed++;
        const errorMsg = e?.message || e?.code || "Unknown error";
        reportError(`[Fallback] FAILED → ${job?.avatarId} | ${errorMsg}`, true);

        if (job?.onFail) {
          try {
            job.onFail(job.avatarId, errorMsg);
          } catch (cbErr) {
            logToMain(cbErr.message, "warn");
          }
        }
      }
      await sleep(100);
    }
  }
}

async function worker() {
  if (running) return;

  running = true;
  workerStarting = false;

  logToMain(`[BatchQueue] STARTED | size=${queue.length}`);

  while (queue.length > 0) {
    const batch = queue.splice(0, BATCH_SIZE);

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
    await sleep(FLUSH_DELAY);
  }

  running = false;
  logToMain("[BatchQueue] STOPPED (empty)");
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
    return;
  }

  queuedSet.add(job.avatarId);
  queue.push({ attempt: 1, ...job });

  if (!running && !workerStarting) {
    workerStarting = true;
    worker();
  }
}

async function enqueueLogAvatar(avatarId) {
  let discordId = "system_log";

  try {
    const fetchedId = await getConfig("Userid.discord_id");
    if (fetchedId && typeof fetchedId === "string" && fetchedId.trim() !== "") {
      discordId = fetchedId.trim();
    }
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
    onFail: (id, err) =>
      logToMain(`[LogSync] Sync error on ${id}: ${err}`, "warn"),
  });
}

setInterval(() => {
  logToMain(
    `[Stats] queue=${queue.length} | processed=${processed} | failed=${failed} | running=${running ? "yes" : "no"}`,
  );
}, 5000);

function getQueueStats() {
  return { queue: queue.length, processed, failed, running };
}

module.exports = {
  enqueueAvatar,
  enqueueLogAvatar,
  getQueueStats,
};
