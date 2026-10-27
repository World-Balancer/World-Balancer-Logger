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
const path = require("path");
const os = require("os");
const fs = require("fs");
const pkg = require("./package.json");

const FOLDER_NAME = "World Balancer";

function getDocumentsDir() {
  try {
    const { app } = require("electron");
    return path.join(app.getPath("documents"), FOLDER_NAME);
  } catch {
    return path.join(os.homedir(), "Documents", FOLDER_NAME);
  }
}

// Per-user folder outside the install directory (e.g. %APPDATA%\<app name>).
// Unlike the install folder, the NSIS uninstaller/updater does not touch it.
function getUserDataDir() {
  try {
    const { app } = require("electron");
    if (app && app.isPackaged) return app.getPath("userData");
  } catch {
    // not running in Electron
  }
  return null;
}

// Where a packaged app used to keep data: beside the executable.
function getLegacyInstallDataDir() {
  try {
    const { app } = require("electron");
    if (app && app.isPackaged) {
      return path.join(path.dirname(process.execPath), "data");
    }
  } catch {
    // not running in Electron
  }
  return null;
}

function isWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.accessSync(dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function getDataDir() {
  // 1) Explicit override
  if (process.env.WB_DATA_DIR) return path.resolve(process.env.WB_DATA_DIR);

  // 2) Portable build
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, "data");
  }

  // 3) Installed app: a persistent per-user folder OUTSIDE the install
  //    directory, so uninstalling or upgrading never deletes the data.
  const userData = getUserDataDir();
  if (userData && isWritable(userData)) return userData;

  // 4) Dev mode, or the user data folder is not writable
  return getDocumentsDir();
}

// Earlier locations of the data folder, oldest layout last. Their contents
// are copied into the current folder once (see ensureDatabase).
function getLegacyDataDirs() {
  const current = getDataDir();
  return [getLegacyInstallDataDir(), getDocumentsDir()].filter(
    (dir, i, all) =>
      dir && dir !== current && all.indexOf(dir) === i && fs.existsSync(dir),
  );
}

function getOldDatabaseCandidates() {
  const home = os.homedir();
  const names = [
    ...new Set([FOLDER_NAME, pkg.productName, pkg.name].filter(Boolean)),
  ];
  const list = [];
  for (const n of names) {
    if (process.platform === "win32") {
      const appData =
        process.env.APPDATA || path.join(home, "AppData", "Roaming");
      list.push(path.join(appData, n, "config", "config.sqlite"));
    } else if (process.platform === "darwin") {
      list.push(
        path.join(
          home,
          "Library",
          "Application Support",
          n,
          "config",
          "config.sqlite",
        ),
      );
    } else {
      list.push(path.join(home, ".config", n, "config", "config.sqlite"));
    }
    list.push(path.join(home, `.${n}`, "config", "config.sqlite"));
  }
  return list;
}

function getDatabasePath() {
  return path.join(getDataDir(), "config", "config.sqlite");
}

// Copies seen_avatar_ids.txt from the old log folder, once.
function migrateLogs() {
  const newLog = path.join(getDataDir(), "log", "seen_avatar_ids.txt");
  if (fs.existsSync(newLog)) return;

  // ...\config\config.sqlite -> ...\log\seen_avatar_ids.txt
  const oldFile = [
    ...getLegacyDataDirs().map((d) =>
      path.join(d, "log", "seen_avatar_ids.txt"),
    ),
    ...getOldDatabaseCandidates().map((p) =>
      path.join(path.dirname(path.dirname(p)), "log", "seen_avatar_ids.txt"),
    ),
  ].find((p) => p !== newLog && fs.existsSync(p));

  if (oldFile) {
    try {
      fs.mkdirSync(path.dirname(newLog), { recursive: true });
      fs.copyFileSync(oldFile, newLog);
    } catch (err) {
      console.error(`Log migration failed: ${err.message}`);
    }
  }
}

// Creates the folder and copies old data once, before Sequelize opens the DB.
function ensureDatabase() {
  const dbPath = getDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  if (!fs.existsSync(dbPath)) {
    const oldDb = [
      ...getLegacyDataDirs().map((d) =>
        path.join(d, "config", "config.sqlite"),
      ),
      ...getOldDatabaseCandidates(),
    ].find((p) => p !== dbPath && fs.existsSync(p));
    if (oldDb) {
      try {
        fs.copyFileSync(oldDb, dbPath); // copy, so the old file stays as a backup
      } catch (err) {
        console.error(`Database migration failed: ${err.message}`);
      }
    }
  }

  migrateLogs();
  return dbPath;
}

module.exports = { getDataDir, getDatabasePath, ensureDatabase };
