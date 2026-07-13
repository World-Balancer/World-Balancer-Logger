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

const Config = require("./Config");
const { log_error } = require("../functions/logsclass");

const configCache = new Map();
const CACHE_TTL_MS = 5000;

function safeJsonParse(rawValue) {
  if (rawValue === null || rawValue === undefined) return null;

  if (typeof rawValue !== "string") return rawValue;

  const trimmed = rawValue.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"'))) {
    return rawValue;
  }

  try {
    return JSON.parse(rawValue);
  } catch {
    return rawValue;
  }
}

async function getConfig(key) {
  if (typeof key !== "string" || !key) {
    log_error.writeErrorToFile(`Invalid config key type or empty string: ${typeof key}`);
    return null;
  }

  const cached = configCache.get(key);
  const now = Date.now();
  if (cached && (now - cached.timestamp < CACHE_TTL_MS)) {
    return cached.value;
  }

  try {
    const config = await Config.findOne({ where: { keyid: key } });
    if (!config) {
      configCache.set(key, { value: null, timestamp: now });
      return null;
    }

    const parsedValue = safeJsonParse(config.value);

    configCache.set(key, { value: parsedValue, timestamp: now });
    return parsedValue;

  } catch (dbError) {
    log_error.writeErrorToFile(`Database error in getConfig("${key}"): ${dbError.message}`);

    return cached ? cached.value : null;
  }
}

module.exports = getConfig;
