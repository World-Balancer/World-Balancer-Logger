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
const { app } = require("electron");
const Config = require("../models/Config");
const { log_error } = require("../functions/logsclass.js");

const appInstallPath = app.getPath("userData");
const logDir = path.join(appInstallPath, "log");
const configDir = path.join(appInstallPath, "config");

Promise.all([
  fs.promises.mkdir(logDir, { recursive: true }),
  fs.promises.mkdir(configDir, { recursive: true })
]).catch((err) => {
  log_error.writeErrorToFile(`Directory initialization error: ${err.message}`);
});

function parseConfigValue(rawValue) {
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

function setNestedProperty(obj, pathStr, value) {
  const parts = pathStr.split(".");
  let current = obj;
  const isUnsafeKey = (key) => key === "__proto__" || key === "constructor" || key === "prototype";

  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (isUnsafeKey(part)) {
      return;
    }
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part];
  }

  const lastPart = parts[parts.length - 1];
  if (isUnsafeKey(lastPart)) {
    return;
  }
  current[lastPart] = value;
}

async function fetchConfig() {
  try {
    const configs = await Config.findAll();
    const result = {};

    for (let i = 0; i < configs.length; i++) {
      const { keyid, value } = configs[i];
      const parsed = parseConfigValue(value);

      if (keyid.includes(".")) {
        setNestedProperty(result, keyid, parsed);
      } else {
        result[keyid] = parsed;
      }
    }

    return result;
  } catch (err) {
    const msg = `Error fetching config: ${err.message}`;
    console.error(msg);
    log_error.writeErrorToFile(msg);
    throw err;
  }
}

async function initializeConfigAndUser() {
  const config = await fetchConfig();
  return { config };
}

module.exports = {
  initializeConfigAndUser,
  configdir: configDir,
  logpath: logDir,
};
