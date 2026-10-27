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
const POINTER_NAME = "location.json";

// The pointer file must live somewhere that never moves, so it is not tied to
// the data folder or to Electron's productName-based userData folder.
function getPointerFile() {
  let base;
  try {
    const { app } = require("electron");
    base = app.getPath("appData");
  } catch {
    const home = os.homedir();
    if (process.platform === "win32") {
      base = process.env.APPDATA || path.join(home, "AppData", "Roaming");
    } else if (process.platform === "darwin") {
      base = path.join(home, "Library", "Application Support");
    } else {
      base = path.join(home, ".config");
    }
  }
  return path.join(base, pkg.name, POINTER_NAME);
}

function readPointer() {
  try {
    const data = JSON.parse(fs.readFileSync(getPointerFile(), "utf8"));
    if (
      data &&
      typeof data.dataDir === "string" &&
      path.isAbsolute(data.dataDir)
    ) {
      return data.dataDir;
    }
  } catch {
    // no pointer file, or unreadable
  }
  return null;
}

function writePointer(dir) {
  const file = getPointerFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ dataDir: dir }, null, 2));
}

function clearPointer() {
  try {
    fs.rmSync(getPointerFile(), { force: true });
  } catch {
    // ignore
  }
}

function getDocumentsDir() {
  try {
    const { app } = require("electron");
    return path.join(app.getPath("documents"), FOLDER_NAME);
  } catch {
    return path.join(os.homedir(), "Documents", FOLDER_NAME);
  }
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

function resolveDataDir() {
  // 1) Explicit override
  if (process.env.WB_DATA_DIR) return path.resolve(process.env.WB_DATA_DIR);

  // 2) Folder chosen by the user inside the app
  const chosen = readPointer();
  if (chosen) {
    if (isWritable(chosen)) return chosen;
    console.error(
      `Chosen data folder is not available: ${chosen}. Using the default.`,
    );
  }

  // 3) Portable build
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, "data");
  }

  // 4) Installed app: data folder next to the .exe
  try {
    const { app } = require("electron");
    if (app && app.isPackaged) {
      const installData = path.join(path.dirname(process.execPath), "data");
      if (isWritable(installData)) return installData;
    }
  } catch {
    // not running in Electron
  }

  // 5) Dev mode, or install folder not writable (e.g. Program Files)
  return getDocumentsDir();
}

// Resolved once per run, so every file sees the same folder.
// Changing the folder restarts the app.
let cachedDataDir = null;
function getDataDir() {
  if (!cachedDataDir) cachedDataDir = resolveDataDir();
  return cachedDataDir;
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

// Copies via a temp file and renames, so dest is either complete or absent.
// Only call this when dest does not exist yet.
function copyFileAtomic(src, dest) {
  const tmp = `${dest}.migrating`;
  try {
    fs.rmSync(tmp, { force: true }); // leftover from an earlier crashed run
    fs.copyFileSync(src, tmp);
    fs.renameSync(tmp, dest);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    fs.rmSync(dest, { force: true });
    throw err;
  }
}

// Copies seen_avatar_ids.txt from the old log folder, once.
// Non-fatal: losing it only means avatars are sent one more time.
function migrateLogs() {
  const newLog = path.join(getDataDir(), "log", "seen_avatar_ids.txt");
  if (fs.existsSync(newLog)) return;

  // ...\config\config.sqlite -> ...\log\seen_avatar_ids.txt
  const oldFile = getOldDatabaseCandidates()
    .map((p) =>
      path.join(path.dirname(path.dirname(p)), "log", "seen_avatar_ids.txt"),
    )
    .find((p) => p !== newLog && fs.existsSync(p));

  if (oldFile) {
    try {
      fs.mkdirSync(path.dirname(newLog), { recursive: true });
      copyFileAtomic(oldFile, newLog);
    } catch (err) {
      console.error(`Log migration failed: ${err.message}`);
    }
  }
}

// Creates the folder and copies old data once, before Sequelize opens the DB.
// Throws if an existing database cannot be migrated, so the app never starts
// on a fresh empty database while the user's real configuration is left behind.
function ensureDatabase() {
  const dbPath = getDatabasePath();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  if (!fs.existsSync(dbPath)) {
    const oldDb = getOldDatabaseCandidates().find(
      (p) => p !== dbPath && fs.existsSync(p),
    );
    if (oldDb) {
      try {
        copyFileAtomic(oldDb, dbPath); // copy, so the old file stays as a backup
      } catch (err) {
        throw new Error(
          `Could not migrate your existing configuration.\n\nFrom: ${oldDb}\nTo: ${dbPath}\n\n${err.message}\n\nYour old data was not changed. Fix the problem (disk space, permissions, antivirus) and start the app again.`,
        );
      }
    }
  }

  migrateLogs();
  return dbPath;
}

// Copies config\ and log\ from the current data folder to dest.
// Existing files in dest are never overwritten; the old folder is left as a backup.
// If anything fails, the folders this call created are removed again.
function copyDataTo(dest) {
  const src = getDataDir();
  const norm = (p) =>
    process.platform === "win32"
      ? path.resolve(p).toLowerCase()
      : path.resolve(p);

  if (norm(src) === norm(dest)) {
    throw new Error("That is already the current data folder.");
  }
  const rel = path.relative(norm(src), norm(dest));
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    throw new Error("Choose a folder outside the current data folder.");
  }

  fs.mkdirSync(dest, { recursive: true });
  const created = []; // only remove what this call created
  try {
    for (const sub of ["config", "log"]) {
      const from = path.join(src, sub);
      if (!fs.existsSync(from)) continue;
      const to = path.join(dest, sub);
      if (!fs.existsSync(to)) created.push(to);
      fs.cpSync(from, to, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    }
  } catch (err) {
    for (const dir of created) fs.rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

module.exports = {
  FOLDER_NAME,
  getDataDir,
  getDatabasePath,
  ensureDatabase,
  copyDataTo,
  writePointer,
  clearPointer,
};
