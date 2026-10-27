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

// Problems found while choosing/preparing the data folder (unavailable
// drive, no permission...). Startup must not crash on these, so they are
// collected here for the caller to show once the UI/logging is ready.
const dataDirWarnings = [];
let resolvedDataDir = null;

function warnDataDir(message) {
  dataDirWarnings.push(message);
  console.error(`[paths] ${message}`);
}

function getDataDirWarnings() {
  return [...dataDirWarnings];
}

function getDataDir() {
  if (resolvedDataDir) return resolvedDataDir;

  // Candidates in priority order. The first one we can actually create and
  // write to wins; unusable ones are reported and skipped, never thrown.
  const candidates = [];

  // 1) Explicit override, read from THIS process's environment only.
  //
  //    On Windows, `setx WB_DATA_DIR "D:\WorldBalancer"` saves the variable for
  //    FUTURE processes. It does not change the PowerShell window, Command
  //    Prompt or Explorer that is already running, and anything launched from
  //    them inherits the old environment, so the override is silently missed
  //    and the app falls back to another data folder.
  //    Either:
  //      - set it in the launching shell first, then start the app from it:
  //          PowerShell:  $env:WB_DATA_DIR = "D:\WorldBalancer"; & ".\World Balancer.exe"
  //          cmd.exe:     set WB_DATA_DIR=D:\WorldBalancer && "World Balancer.exe"
  //      - or run `setx` and then close and reopen that terminal (and, for
  //        launches from the desktop or Start menu, sign out and back in or
  //        restart Explorer) before starting the app.
  //    When the override is set but unusable, getDataDirWarnings() says so.
  if (process.env.WB_DATA_DIR) {
    candidates.push({
      dir: path.resolve(process.env.WB_DATA_DIR),
      label: "WB_DATA_DIR",
    });
  }

  // 2) Portable build
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    candidates.push({
      dir: path.join(process.env.PORTABLE_EXECUTABLE_DIR, "data"),
      label: "portable data folder",
    });
  }

  // 3) Installed app: a persistent per-user folder OUTSIDE the install
  //    directory, so uninstalling or upgrading never deletes the data.
  const userData = getUserDataDir();
  if (userData) candidates.push({ dir: userData, label: "user data folder" });

  // 4) Dev mode, or the folders above are not usable
  candidates.push({ dir: getDocumentsDir(), label: "Documents folder" });

  // 5) Last resort so the app can still start (data here is not persistent)
  candidates.push({
    dir: path.join(os.tmpdir(), FOLDER_NAME),
    label: "temporary folder",
  });

  for (let i = 0; i < candidates.length; i++) {
    const { dir, label } = candidates[i];
    if (isWritable(dir)) {
      if (i > 0 && dataDirWarnings.length > 0) {
        warnDataDir(`Using ${label} instead: ${dir}`);
      }
      resolvedDataDir = dir;
      return dir;
    }
    warnDataDir(`Cannot use ${label} "${dir}": it is missing or not writable.`);
  }

  // Nothing is writable at all: return the best guess without throwing.
  resolvedDataDir = candidates[candidates.length - 1].dir;
  return resolvedDataDir;
}

const HISTORY_FILE = "data-dir-history.json";
const MAX_HISTORY = 10;

function getAppNames() {
  return [...new Set([FOLDER_NAME, pkg.productName, pkg.name].filter(Boolean))];
}

// The history lives in Electron's user data folder, which stays put even
// when the data folder or the install folder changes.
function getHistoryPath() {
  try {
    const { app } = require("electron");
    return path.join(app.getPath("userData"), HISTORY_FILE);
  } catch {
    return null;
  }
}

function readDataDirHistory() {
  const file = getHistoryPath();
  if (!file) return [];
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(list) ? list.filter((d) => typeof d === "string") : [];
  } catch {
    return [];
  }
}

// Remembers every data folder this app has used, newest first.
function recordDataDir(dir) {
  const file = getHistoryPath();
  if (!file) return;
  try {
    const list = [dir, ...readDataDirHistory().filter((d) => d !== dir)];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(list.slice(0, MAX_HISTORY), null, 2));
  } catch (err) {
    console.error(`Could not record data folder: ${err.message}`);
  }
}

// Every place the data folder could have been before: folders used earlier
// (history), beside the current executable, the previous override / portable
// folder, the Documents fallback and the default installer locations.
function getPreviousDataDirs() {
  const current = getDataDir();
  const dirs = [...readDataDirHistory()];

  const installData = getLegacyInstallDataDir();
  if (installData) dirs.push(installData);

  if (process.env.WB_DATA_DIR) dirs.push(path.resolve(process.env.WB_DATA_DIR));
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    dirs.push(path.join(process.env.PORTABLE_EXECUTABLE_DIR, "data"));
  }

  dirs.push(getDocumentsDir());

  if (process.platform === "win32") {
    const localAppData =
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    const roots = [
      path.join(localAppData, "Programs"),
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
    ].filter(Boolean);
    for (const root of roots) {
      for (const name of getAppNames())
        dirs.push(path.join(root, name, "data"));
    }
  }

  const resolved = dirs.map((d) => path.resolve(d));
  return resolved.filter(
    (d, i) =>
      d !== path.resolve(current) &&
      resolved.indexOf(d) === i &&
      fs.existsSync(d),
  );
}

// The most recently modified non-empty file, so the freshest data wins.
function pickNewest(files) {
  let best = null;
  let bestTime = -1;
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      if (st.isFile() && st.size > 0 && st.mtimeMs > bestTime) {
        best = f;
        bestTime = st.mtimeMs;
      }
    } catch {
      // missing or unreadable: skip
    }
  }
  return best;
}

function getOldDatabaseCandidates() {
  const home = os.homedir();
  const names = getAppNames();
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
  const oldFile = pickNewest(
    [
      ...getPreviousDataDirs().map((d) =>
        path.join(d, "log", "seen_avatar_ids.txt"),
      ),
      ...getOldDatabaseCandidates().map((p) =>
        path.join(path.dirname(path.dirname(p)), "log", "seen_avatar_ids.txt"),
      ),
    ].filter((p) => p !== newLog),
  );

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
  try {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  } catch (err) {
    // Never let this escape: it runs while modules are being required, so
    // a throw here would abort startup before the window opens.
    warnDataDir(
      `Cannot create the database folder "${path.dirname(dbPath)}": ${err.message}`,
    );
    return dbPath;
  }

  if (!fs.existsSync(dbPath)) {
    const oldDb = pickNewest(
      [
        ...getPreviousDataDirs().map((d) =>
          path.join(d, "config", "config.sqlite"),
        ),
        ...getOldDatabaseCandidates(),
      ].filter((p) => p !== dbPath),
    );
    if (oldDb) {
      try {
        fs.copyFileSync(oldDb, dbPath); // copy, so the old file stays as a backup
      } catch (err) {
        console.error(`Database migration failed: ${err.message}`);
      }
    }
  }

  migrateLogs();
  recordDataDir(getDataDir()); // so a later move can find this folder again
  return dbPath;
}

module.exports = {
  getDataDir,
  getDatabasePath,
  ensureDatabase,
  getDataDirWarnings,
};
