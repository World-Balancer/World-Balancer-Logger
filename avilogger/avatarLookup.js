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

// Looks up an avatar's name on the World Balancer avatar server:
//   GET <LOOKUP_URL>/<avatar id> ->   { "id": "avtr_...", "name": "..." }
// "Avatar not found" (HTTP 404, or that message in the answer) means the
// avatar is private or gone, and is reported as status "private".
//
// lookupAvatar() never rejects and always resolves to one of
//   { status: "found",   name }
//   { status: "private" }
//   { status: "error",   message }   (server unreachable or answered oddly)
//
// Lookups are gentle on the server: they wait in a queue and go out one at a
// time with a pause between them, the same avatar is never asked for twice,
// answers are remembered, a 429 "slow down" pauses the whole queue, and after
// repeated failures nothing is sent for a minute.

const axios = require("axios");
const https = require("https");
const main = require("../main");
const { log_error } = require("../functions/logsclass.js");
const { version } = require("../package.json");
const { parseRetryAfterMs } = require("./avatarQueue.js");

const LOOKUP_URL = "https://avatarwbvrcxsearch.worldbalancer.com/vrc_avatar";

// One lookup at a time, in the order the avatars were seen, with a pause
// between requests (about 2 per second at most, however many avatars load).
const MIN_GAP_MS = 500;
const MAX_QUEUE = 300; // lookups waiting; more than this get "busy" (Retry)
const MAX_RETRIES = 1; // for temporary errors (network, 429, 5xx)
const RETRY_DELAY_MS = 2000;
const MAX_RETRY_WAIT_MS = 10000;

const FOUND_TTL_MS = Infinity; // a name does not change during a session
const PRIVATE_TTL_MS = 30 * 60 * 1000; // an avatar can be made public later
const ERROR_TTL_MS = 60 * 1000; // do not hammer a server that just failed
const MAX_CACHE_ENTRIES = 2000;

const BREAKER_FAILURES = 3; // this many failed lookups in a row...
const BREAKER_PAUSE_MS = 60 * 1000; // ...and nothing is sent for this long

const MAX_NAME_LENGTH = 100;

// Same check as the server's /vrc_avatar route, so we never refuse an ID it would accept
const AVATAR_ID_REGEX =
  /^avtr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const httpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 30000,
  maxSockets: 1,
  maxFreeSockets: 1,
  scheduling: "lifo",
});

const axiosInstance = axios.create({
  timeout: 10000,
  maxRedirects: 0,
  httpsAgent,
  validateStatus: () => true, // every HTTP answer is handled below, 404 included
  headers: {
    // No space in the app name: the server reads "app/version email"
    "User-Agent": `WorldBalancer/${version} contact@worldbalancer.com`,
  },
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function reportError(message) {
  log_error.writeErrorToFile(message);
}

const cache = new Map(); // avatar id -> { result, expires }
const inflight = new Map(); // avatar id -> Promise
const queue = []; // [{ id, resolve }] in the order they were asked for
let running = false;
let consecutiveFailures = 0;
let breakerUntil = 0;
let pausedUntil = 0; // set by 429 / Retry-After: the whole queue waits

function remember(id, result, ttl) {
  cache.delete(id); // re-insert so the oldest entry is the first one in the map
  cache.set(id, { result, expires: Date.now() + ttl });
  while (cache.size > MAX_CACHE_ENTRIES) {
    cache.delete(cache.keys().next().value);
  }
}

// One request. Resolves to { done: result }, or { error, retry?, waitMs? }.
async function requestOnce(id) {
  let res;
  try {
    res = await axiosInstance.get(`${LOOKUP_URL}/${encodeURIComponent(id)}`);
  } catch (err) {
    return {
      error: `could not reach the avatar server (${err.code || err.message})`,
      retry: true,
    };
  }

  const body = res.data && typeof res.data === "object" ? res.data : null;
  const text = body ? body.error || body.message : null;

  // The server's way of saying it has no such avatar
  if (
    res.status === 404 ||
    (typeof text === "string" && /avatar not found/i.test(text))
  ) {
    return { done: { status: "private" } };
  }

  if (res.status === 200) {
    const name = body && typeof body.name === "string" ? body.name.trim() : "";
    const idMatches =
      !body ||
      typeof body.id !== "string" ||
      body.id.toLowerCase() === id.toLowerCase();
    if (name && idMatches) {
      return {
        done: { status: "found", name: name.slice(0, MAX_NAME_LENGTH) },
      };
    }
    return {
      error: "the avatar server sent an answer that could not be understood",
    };
  }

  if (res.status === 429 || (res.status >= 500 && res.status <= 599)) {
    return {
      error: `the avatar server answered ${res.status}`,
      retry: true,
      waitMs: parseRetryAfterMs(res.headers?.["retry-after"]),
    };
  }
  return { error: `the avatar server answered ${res.status}` };
}

// Runs one queued lookup (with its retries) and returns its result.
async function doLookup(id) {
  if (Date.now() < breakerUntil) {
    return {
      status: "error",
      message: "The avatar server is not answering. Trying again shortly.",
    };
  }

  let last = null;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const r = await requestOnce(id);

    if (r.done) {
      consecutiveFailures = 0;
      remember(
        id,
        r.done,
        r.done.status === "found" ? FOUND_TTL_MS : PRIVATE_TTL_MS,
      );
      return r.done;
    }

    last = r;
    if (!r.retry || attempt === MAX_RETRIES) break;
    const wait = Math.min(
      r.waitMs ?? RETRY_DELAY_MS * (attempt + 1),
      MAX_RETRY_WAIT_MS,
    );
    // Everything behind this lookup waits too, not just this one
    pausedUntil = Math.max(pausedUntil, Date.now() + wait);
    await sleep(wait);
  }

  consecutiveFailures += 1;
  if (consecutiveFailures >= BREAKER_FAILURES) {
    breakerUntil = Date.now() + BREAKER_PAUSE_MS;
    consecutiveFailures = 0;
    main.log(
      "[Lookup] The avatar server is not answering. Pausing name lookups for a minute.",
      "warn",
      "main_log",
    );
  }
  const result = { status: "error", message: last.error };
  remember(id, result, ERROR_TTL_MS);
  reportError(`[Lookup] ${id}: ${last.error}`);
  return result;
}

async function runWorker() {
  if (running) return;
  running = true;
  try {
    while (queue.length > 0) {
      const wait = pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);

      const job = queue.shift();
      let result;
      try {
        result = await doLookup(job.id);
      } catch (err) {
        reportError(`[Lookup] Unexpected error for ${job.id}: ${err.message}`);
        result = {
          status: "error",
          message: "Something went wrong during the lookup.",
        };
      }
      job.resolve(result);
      if (queue.length > 0) await sleep(MIN_GAP_MS);
    }
  } finally {
    running = false;
    if (queue.length > 0) runWorker(); // a job arrived while the loop was ending
  }
}

/**
 * Drops every lookup that has not been sent yet (used when the list is cleared).
 * Their promises resolve with an error nobody is waiting for.
 */
function clearLookupQueue() {
  for (const job of queue.splice(0)) {
    inflight.delete(job.id);
    job.resolve({ status: "error", message: "Cancelled." });
  }
}

/**
 * Looks up an avatar by ID. Never rejects.
 */
function lookupAvatar(id) {
  if (typeof id !== "string" || !AVATAR_ID_REGEX.test(id)) {
    return Promise.resolve({
      status: "error",
      message: "Not a valid avatar ID.",
    });
  }

  const hit = cache.get(id);
  if (hit && hit.expires > Date.now()) return Promise.resolve(hit.result);

  const running = inflight.get(id);
  if (running) return running;

  if (queue.length >= MAX_QUEUE) {
    return Promise.resolve({
      status: "error",
      message: "Too many lookups are waiting. Press Retry in a moment.",
    });
  }

  const promise = new Promise((resolve) => queue.push({ id, resolve }));
  inflight.set(id, promise);
  promise.then(() => inflight.delete(id));
  runWorker();
  return promise;
}

/** Forgets the saved answer for an avatar, so the next lookup asks the server. */
function forgetAvatar(id) {
  cache.delete(id);
}

/** Lets lookups go out again right away after a pause caused by failures. */
function resetLookupBreaker() {
  breakerUntil = 0;
  consecutiveFailures = 0;
}

module.exports = {
  lookupAvatar,
  forgetAvatar,
  resetLookupBreaker,
  clearLookupQueue,
};
