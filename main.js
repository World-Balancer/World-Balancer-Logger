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

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const fs = require("fs").promises;
const fsSync = require("fs");
const os = require("os");
const { getDatabasePath, getDataDir, getDataDirWarnings } = require("./paths");

// ensureDatabase() runs when configsqlite is first loaded and throws if an
// existing database cannot be migrated. Show the reason and quit instead of
// starting on an empty database.
let sequelize;
try {
  sequelize = require("./models/configsqlite");
} catch (err) {
  dialog.showErrorBox("World Balancer could not start", err.message);
  app.exit(1);
  return; // stops the rest of main.js from loading
}
const Config = require("./models/Config");
const { version } = require("./package.json");
const { avatar_id_store } = require("./functions/avatarIdStore.js");

const isWindows = process.platform === "win32";
let mainWindow = null;
let logQueue = [];

async function doesDatabaseExist() {
  try {
    await fs.access(getDatabasePath(), fsSync.constants.F_OK);
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

function getDefaultConfig() {
  const logDirectory = isWindows
    ? path.join(os.homedir(), "AppData", "LocalLow", "VRChat", "VRChat")
    : path.join(os.homedir(), ".Config", "VRChat", "VRChat");

  return Promise.resolve({
    Directories: { LogDirectory: logDirectory },
    Userid: {
      discord_id: "",
    },
  });
}

async function updateMissingKeys(defaultConfig, currentConfig, parentKey = "") {
  for (const [key, defaultValue] of Object.entries(defaultConfig)) {
    const currentKey = parentKey ? `${parentKey}.${key}` : key;

    if (
      typeof defaultValue === "object" &&
      defaultValue !== null &&
      !Array.isArray(defaultValue)
    ) {
      await updateMissingKeys(
        defaultValue,
        currentConfig[key] || {},
        currentKey,
      );
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

// Sends something to the window (no-op while it is closed or still loading;
// the window asks for the full state when it opens).
function sendToWindow(channel, data) {
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send(channel, data);
  }
}

function initAppWindow() {
  if (mainWindow) return;

  mainWindow = new BrowserWindow({
    width: 825,
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

ipcMain.handle("get-user-data-path", () => getDataDir());
ipcMain.handle("load-config", loadConfig);
ipcMain.handle("save-config", async (_, config) => {
  await saveConfigRecursively(config);

  // getConfig caches for a few seconds: tell the Discord ID holder about the new
  // value so reports and lookups sent right after saving use the new one.
  const discordId = config?.Userid?.discord_id;
  if (typeof discordId === "string") {
    try {
      require("./avilogger/discordId.js").noteDiscordIdSaved(discordId);
    } catch (err) {
      console.error("noteDiscordIdSaved failed:", err.message);
    }
  }
});

// Avatar links from the Avatars tab: only these exact avatar URLs are opened.
const OPEN_EXTERNAL_ALLOWED =
  /^(https:\/\/vrchat\.com\/home\/avatar\/|vrcx:\/\/avatar\/|vrcx-0:\/\/avatar\/open\?id=)avtr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

ipcMain.handle("open-external", async (_, url) => {
  if (typeof url !== "string" || !OPEN_EXTERNAL_ALLOWED.test(url)) return false;
  try {
    await shell.openExternal(url);
    return true;
  } catch (err) {
    log(`Could not open link: ${err.message}`, "warn");
    return false;
  }
});
ipcMain.handle("get-app-version", () => version);

// Avatars tab: the list kept by seenAvatars.js (required lazily, see below).
ipcMain.handle("get-seen-avatars", () =>
  require("./avilogger/seenAvatars.js").getSeenAvatars(),
);
ipcMain.handle("clear-seen-avatars", () =>
  require("./avilogger/seenAvatars.js").clearSeenAvatars(),
);

ipcMain.handle("retry-avatar-lookup", (_, id) =>
  typeof id === "string"
    ? require("./avilogger/seenAvatars.js").retryLookup(id)
    : false,
);

// "Report" button: the window asks, reportQueue.js sends it to the reports API.
// Required lazily because reportQueue requires this module (same reason as the
// avatarQueue require in before-quit below).
ipcMain.handle("report-avatar", async (_, payload) => {
  try {
    const { submitReport } = require("./avilogger/reportQueue.js");
    return await submitReport(payload?.avatarId, payload?.reason);
  } catch (err) {
    console.error("report-avatar failed:", err.message);
    return {
      ok: false,
      code: "error",
      message: "The report could not be sent.",
    };
  }
});

app.on("ready", async () => {
  // Folder problems found while choosing the data folder (unavailable
  // WB_DATA_DIR, no write permission...). They were collected instead of
  // thrown, so surface them now that logging and the window exist.
  for (const warning of getDataDirWarnings()) log(warning, "warn");

  await initializeDatabase();
  app.emit("db-ready");
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

// Give in-flight uploads a short time to finish (so they are confirmed and
// saved), then wait for any running disk write before the app really exits.
// flushSync() is the fallback if that takes too long or fails.
const QUIT_FLUSH_TIMEOUT_MS = 5000;
let quitFlushStarted = false;

app.on("before-quit", (event) => {
  if (quitFlushStarted) {
    avatar_id_store.flushSync(); // second pass: nothing may be left outstanding
    return;
  }
  quitFlushStarted = true;
  event.preventDefault();

  let timer;
  const flush = (async () => {
    // Required lazily: avatarQueue requires this module, so a top-level
    // require here would hand it a half-loaded `main`.
    const { waitForIdle } = require("./avilogger/avatarQueue.js");
    await waitForIdle(3000);
    await avatar_id_store.flushAll();
  })();

  Promise.race([
    flush,
    new Promise((resolve) => {
      timer = setTimeout(resolve, QUIT_FLUSH_TIMEOUT_MS);
    }),
  ])
    .catch((err) => console.error("Shutdown flush failed:", err.message))
    .finally(() => {
      clearTimeout(timer);
      avatar_id_store.flushSync();
      app.quit(); // runs this handler again, which now returns immediately
    });
});

module.exports = { log, sendToWindow };
