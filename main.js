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

const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs").promises;
const os = require("os");
const sequelize = require("./models/configsqlite");
const Config = require("./models/Config");
const { version, name: appName } = require("./package.json");

const isWindows = process.platform === "win32";
let mainWindow = null;
let logQueue = [];

function getDatabasePath() {
  const baseDir = isWindows
    ? path.join(process.env.APPDATA || "", appName, "config")
    : path.join(os.homedir(), `.${appName}`, "config");
  return path.join(baseDir, "config.sqlite");
}

async function doesDatabaseExist() {
  try {
    await fs.access(getDatabasePath(), fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function saveConfigRecursively(obj, parentKey = "") {
  for (const [key, value] of Object.entries(obj)) {
    const currentKey = parentKey ? `${parentKey}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      await saveConfigRecursively(value, currentKey);
    } else {
      await Config.upsert({ keyid: currentKey, value: JSON.stringify(value) });
    }
  }
}

async function loadConfig() {
  try {
    const configEntries = await Config.findAll();
    const configObject = {};
    for (const { keyid, value } of configEntries) {
      const keys = keyid.split(".");
      let current = configObject;
      keys.forEach((key, i) => {
        if (i === keys.length - 1) {
          current[key] = JSON.parse(value);
        } else {
          current[key] = current[key] || {};
          current = current[key];
        }
      });
    }
    return configObject;
  } catch (error) {
    log(`loadConfig() error: ${error.message}`, "error");
    return {};
  }
}

function flattenKeys(obj, parentKey = "") {
  let keys = [];
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = parentKey ? `${parentKey}.${key}` : key;
    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      keys = keys.concat(flattenKeys(value, fullKey));
    } else {
      keys.push(fullKey);
    }
  }
  return keys;
}

async function getDefaultConfig() {
  const logDirectory = isWindows
    ? path.join(os.homedir(), "AppData", "LocalLow", "VRChat", "VRChat")
    : path.join(os.homedir(), ".Config", "VRChat", "VRChat");

  return {
    Directories: { LogDirectory: logDirectory },
    Userid: {
      discord_id: "",
    }
  };
}

async function updateMissingKeys(defaultConfig, currentConfig, parentKey = "") {
  for (const [key, defaultValue] of Object.entries(defaultConfig)) {
    const currentKey = parentKey ? `${parentKey}.${key}` : key;

    if (typeof defaultValue === "object" && defaultValue !== null && !Array.isArray(defaultValue)) {
      await updateMissingKeys(defaultValue, currentConfig[key] || {}, currentKey);
    } else if (currentConfig[key] === undefined) {
      log(`Adding missing key: ${currentKey}`, "info");
      await Config.upsert({
        keyid: currentKey,
        value: JSON.stringify(defaultValue),
      });
    }
  }
}

async function removeUnusedKeys(currentConfig, defaultConfig) {
  const defaultKeys = new Set(flattenKeys(defaultConfig));
  const currentKeys = flattenKeys(currentConfig);

  for (const key of currentKeys) {
    if (!defaultKeys.has(key)) {
      log(`Removing unused key: ${key}`, "info");
      await Config.destroy({ where: { keyid: key } });
    }
  }
}

async function migrateConfig() {
  const currentConfig = await loadConfig();
  const defaultConfig = await getDefaultConfig();
  await updateMissingKeys(defaultConfig, currentConfig);
  await removeUnusedKeys(currentConfig, defaultConfig);
}

async function initializeDatabase() {
  try {
    const dbExists = await doesDatabaseExist();
    await sequelize.authenticate();
    await sequelize.sync({ alter: true });

    if (!dbExists) {
      log("Creating new config...", "info");
      const defaultConfig = await getDefaultConfig();
      await saveConfigRecursively(defaultConfig);
    } else {
      log("Migrating existing config...", "info");
      await migrateConfig();
    }
  } catch (error) {
    console.error("initializeDatabase():", error);
  }
}

function log(message, level = "info", type = "main_log") {
  const logData = { type, message: `${message}`, level };

  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send("app-log", logData);
  } else {
    logQueue.push(logData);
  }
}

function initAppWindow() {
  if (mainWindow) return;

  mainWindow = new BrowserWindow({
    width: 800,
    height: 825,
    icon: path.join(__dirname, "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, "index.html"));

  mainWindow.webContents.once("did-finish-load", () => {
    mainWindow.webContents.send("app-version", version);

    logQueue.forEach((entry) => mainWindow.webContents.send("app-log", entry));
    logQueue = [];
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("get-user-data-path", () => app.getPath("userData"));
ipcMain.handle("load-config", loadConfig);
ipcMain.handle("save-config", async (_, config) => await saveConfigRecursively(config));
ipcMain.handle("get-app-version", () => version);

app.on("ready", async () => {
  await initializeDatabase();
  initAppWindow();
});

app.on("activate", async () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    await initializeDatabase();
    initAppWindow();
  }
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

module.exports = { log };
