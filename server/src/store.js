import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
const DB_FILE = path.join(DATA_DIR, "db.json");

const DEFAULT_DB = {
  settings: {
    polymerApiKey: "",
    anthropicApiKey: "",
    jobId: "",
  },
  prompts: {}, // jobId -> custom prompt string (absent = use built-in default)
  jobMeta: {}, // jobId -> { title, location } cached for history/UI labels
  lastScanAt: null,
  nextScanAt: null,
  scanning: false,
  scanProgress: null, // { current, total, currentName }
  results: {},
  history: [], // [{ startedAt, finishedAt, jobId, jobTitle, scanned, flagged, kept, archived, error }]
};

let db = null;
let writeQueue = Promise.resolve();

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadFromDisk() {
  ensureDir();
  if (!fs.existsSync(DB_FILE)) {
    db = structuredClone(DEFAULT_DB);
    fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
    return;
  }
  try {
    const raw = fs.readFileSync(DB_FILE, "utf8");
    const parsed = JSON.parse(raw);
    db = { ...structuredClone(DEFAULT_DB), ...parsed };
    db.settings = { ...DEFAULT_DB.settings, ...(parsed.settings || {}) };
    db.prompts = { ...(parsed.prompts || {}) };
    db.jobMeta = { ...(parsed.jobMeta || {}) };
    // migrate legacy single-prompt setting -> per-job map for the active job
    if (parsed?.settings?.prompt && db.settings.jobId && !db.prompts[db.settings.jobId]) {
      db.prompts[db.settings.jobId] = parsed.settings.prompt;
    }
    delete db.settings.prompt;
  } catch (err) {
    console.error("Failed to read db.json, starting fresh:", err.message);
    db = structuredClone(DEFAULT_DB);
  }
}

function persist() {
  const snapshot = JSON.stringify(db, null, 2);
  writeQueue = writeQueue.then(
    () =>
      new Promise((resolve) => {
        fs.writeFile(DB_FILE, snapshot, (err) => {
          if (err) console.error("DB write failed:", err.message);
          resolve();
        });
      })
  );
  return writeQueue;
}

export function initStore() {
  loadFromDisk();
  // API keys are .env-only — always re-read on boot so updates take effect.
  db.settings.polymerApiKey = process.env.POLYMER_API_KEY || "";
  db.settings.anthropicApiKey = process.env.ANTHROPIC_API_KEY || "";
  // Any "scanning" flag from a previous process is stale — the scan died
  // with that process. Reset live-state fields so the UI doesn't get stuck
  // on a ghost scan after a server restart.
  db.scanning = false;
  db.scanProgress = null;
  // Also mark any in-flight history row as failed so it doesn't read as "Running" forever.
  if (db.history && db.history[0] && !db.history[0].finishedAt) {
    db.history[0].finishedAt = new Date().toISOString();
    db.history[0].error = db.history[0].error || "Scan interrupted (server restarted)";
  }
  persist();
}

export function getState() {
  return db;
}

export function getSettings() {
  return { ...db.settings };
}

export function updateSettings(patch) {
  db.settings = { ...db.settings, ...patch };
  persist();
  return db.settings;
}

export function setScanState({ scanning, progress }) {
  if (typeof scanning === "boolean") db.scanning = scanning;
  if (progress !== undefined) db.scanProgress = progress;
  persist();
}

export function recordScanStart({ jobId, jobTitle } = {}) {
  const entry = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    jobId: jobId || null,
    jobTitle: jobTitle || null,
    scanned: 0,
    flagged: 0,
    kept: 0,
    archived: 0,
    error: null,
  };
  db.history.unshift(entry);
  if (db.history.length > 100) db.history.length = 100;
  persist();
  return entry;
}

export function getPrompt(jobId) {
  if (!jobId) return null;
  return db.prompts[String(jobId)] || null;
}

export function setPrompt(jobId, prompt) {
  const id = String(jobId);
  if (prompt == null || prompt === "") delete db.prompts[id];
  else db.prompts[id] = prompt;
  persist();
  return db.prompts[id] || null;
}

export function rememberJobMeta(jobId, meta) {
  if (!jobId) return;
  db.jobMeta[String(jobId)] = { ...(db.jobMeta[String(jobId)] || {}), ...meta };
  persist();
}

export function getJobMeta(jobId) {
  return db.jobMeta[String(jobId)] || null;
}

export function updateLatestHistory(patch) {
  if (!db.history.length) return;
  Object.assign(db.history[0], patch);
  persist();
}

const SCAN_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

export function setLastScan(at) {
  db.lastScanAt = at;
  db.nextScanAt = new Date(new Date(at).getTime() + SCAN_INTERVAL_MS).toISOString();
  persist();
}

export function setNextScan(at) {
  db.nextScanAt = at;
  persist();
}

export function getResult(appId) {
  return db.results[String(appId)];
}

export function saveResult(appId, value) {
  db.results[String(appId)] = {
    ...(db.results[String(appId)] || {}),
    ...value,
  };
  persist();
  return db.results[String(appId)];
}

export function listResults() {
  return Object.entries(db.results).map(([id, v]) => ({ id, ...v }));
}

export function clearResultsForJob(jobId) {
  for (const [id, v] of Object.entries(db.results)) {
    if (String(v.jobId) === String(jobId)) delete db.results[id];
  }
  persist();
}
