import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const __filename = fileURLToPath(import.meta.url);
const __dirnameInit = path.dirname(__filename);
// Always load the .env from the repo root, regardless of cwd.
// Load .env from the repo root; override existing process env so the file
// always wins over inherited or shell-set values (which may be empty).
const envPath = path.resolve(__dirnameInit, "..", "..", ".env");
dotenv.config({ path: envPath, override: true });

import express from "express";
import cors from "cors";

import {
  getSettings,
  updateSettings,
  getState,
  listResults,
  getResult,
  saveResult,
  getPrompt,
  setPrompt,
  rememberJobMeta,
  getJobMeta,
} from "./store.js";
import { initStore } from "./store.js";
import { listJobs, archiveApplication } from "./polymer.js";
import { isScanning, runScan, getEventLog, SCAN_MODEL } from "./scanner.js";
import { startScheduler, SCAN_INTERVAL_DAYS } from "./scheduler.js";
import { DEFAULT_CRITERIA, hashPrompt, stripOutputSpec } from "./screener.js";
import { setNextScan } from "./store.js";

initStore();
startScheduler();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

const PORT = Number(process.env.PORT) || 3001;

// --- helpers -----------------------------------------------------------------

function maskKey(value) {
  if (!value) return "";
  const v = String(value);
  if (v.length <= 8) return "*".repeat(v.length);
  return `${v.slice(0, 4)}…${v.slice(-4)}`;
}

function currentPromptHashFor(jobId) {
  const criteria = stripOutputSpec(getPrompt(jobId) || DEFAULT_CRITERIA);
  return hashPrompt(criteria);
}

function isOutdated(result) {
  if (!result || !result.jobId) return false;
  return result.promptHash !== currentPromptHashFor(result.jobId);
}

function publicSettings() {
  const s = getSettings();
  return {
    hasPolymerKey: !!s.polymerApiKey,
    hasAnthropicKey: !!s.anthropicApiKey,
    polymerKeyMasked: maskKey(s.polymerApiKey),
    anthropicKeyMasked: maskKey(s.anthropicApiKey),
    jobId: s.jobId || "",
    defaultPrompt: DEFAULT_CRITERIA,
  };
}

function requireConfigured(res) {
  const s = getSettings();
  if (!s.polymerApiKey) {
    res.status(400).json({ error: "Polymer API key not configured" });
    return false;
  }
  if (!s.anthropicApiKey) {
    res.status(400).json({ error: "Anthropic API key not configured" });
    return false;
  }
  return true;
}

// --- routes ------------------------------------------------------------------

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.get("/api/status", (_req, res) => {
  const state = getState();
  const settings = getSettings();
  const results = listResults();
  const stats = results.reduce(
    (acc, r) => {
      acc.total += 1;
      if (r.archived) acc.archived += 1;
      else if (r.overridden) acc.kept += 1;
      else if (r.decision === "ARCHIVE") acc.flagged += 1;
      else acc.kept += 1;
      return acc;
    },
    { total: 0, flagged: 0, kept: 0, archived: 0 }
  );
  // Outdated count = results for the active job whose promptHash differs from current.
  const activeJobId = settings.jobId;
  const outdatedForActiveJob = activeJobId
    ? results.filter(
        (r) => String(r.jobId) === String(activeJobId) && isOutdated(r)
      ).length
    : 0;
  stats.outdated = outdatedForActiveJob;
  res.json({
    configured: !!(settings.polymerApiKey && settings.anthropicApiKey),
    hasActiveJob: !!settings.jobId,
    scanning: state.scanning,
    progress: state.scanProgress,
    lastScanAt: state.lastScanAt,
    nextScanAt: state.nextScanAt,
    scanIntervalDays: SCAN_INTERVAL_DAYS,
    jobId: settings.jobId,
    stats,
    latestHistory: state.history?.[0] || null,
    model: SCAN_MODEL,
    events: getEventLog(),
  });
});

app.get("/api/settings", (_req, res) => {
  res.json(publicSettings());
});

app.put("/api/settings", (req, res) => {
  const body = req.body || {};
  const patch = {};
  if (typeof body.jobId === "string") patch.jobId = body.jobId.trim();
  updateSettings(patch);
  // If we now have a job and there's no next-scan scheduled, seed one.
  const state = getState();
  const settings = getSettings();
  if (settings.jobId && !state.nextScanAt) {
    setNextScan(new Date(Date.now() + SCAN_INTERVAL_DAYS * 24 * 60 * 60 * 1000).toISOString());
  }
  res.json(publicSettings());
});

app.get("/api/prompts/:jobId", (req, res) => {
  const raw = getPrompt(req.params.jobId);
  const cleaned = raw ? stripOutputSpec(raw) : null;
  res.json({
    jobId: req.params.jobId,
    prompt: cleaned,
    isCustom: !!cleaned,
    defaultPrompt: DEFAULT_CRITERIA,
    currentHash: currentPromptHashFor(req.params.jobId),
  });
});

app.put("/api/prompts/:jobId", (req, res) => {
  const body = req.body || {};
  // Always strip any JSON-schema tail the user may have pasted — criteria only.
  const cleaned =
    typeof body.prompt === "string" && body.prompt.trim()
      ? stripOutputSpec(body.prompt)
      : null;
  setPrompt(req.params.jobId, cleaned);
  res.json({
    jobId: req.params.jobId,
    prompt: cleaned,
    isCustom: !!cleaned,
    defaultPrompt: DEFAULT_CRITERIA,
    currentHash: currentPromptHashFor(req.params.jobId),
  });
});

const ACTIVE_STATUSES = new Set(["published", "active", "open", "live"]);

app.get("/api/jobs", async (_req, res) => {
  const settings = getSettings();
  if (!settings.polymerApiKey) {
    return res.status(400).json({ error: "Polymer API key not configured" });
  }
  try {
    const { items } = await listJobs(settings.polymerApiKey);
    const normalized = items
      .map((j) => ({
        id: String(j.id ?? j.job_id ?? j._id ?? ""),
        title: j.title || j.name || j.job_title || `Job ${j.id ?? ""}`,
        status: j.status || j.state || null,
        location:
          j.location ||
          j.city ||
          [j.city, j.country].filter(Boolean).join(", ") ||
          null,
        department: j.department || null,
      }))
      .filter((j) => {
        if (!j.status) return true; // if Polymer doesn't expose status, keep it
        return ACTIVE_STATUSES.has(String(j.status).toLowerCase());
      });
    for (const j of normalized) {
      rememberJobMeta(j.id, { title: j.title, location: j.location });
    }
    console.log(`[/api/jobs] returning ${normalized.length} job(s)`);
    res.json({ jobs: normalized });
  } catch (err) {
    console.error("[/api/jobs] error:", err.message, err.body || "");
    res.status(err.status || 500).json({ error: err.message, body: err.body || null });
  }
});

app.post("/api/scan", async (req, res) => {
  if (!requireConfigured(res)) return;
  const settings = getSettings();
  const jobId = (req.body && req.body.jobId) || settings.jobId;
  if (!jobId) return res.status(400).json({ error: "No job ID provided" });
  const rescreenAll = !!(req.body && req.body.rescreenAll);
  const onlyOutdated = !!(req.body && req.body.onlyOutdated);
  if (isScanning()) {
    return res.status(409).json({ error: "A scan is already running" });
  }
  // fire-and-forget; client polls /api/status for progress
  runScan({ jobId, rescreenAll, onlyOutdated }).catch((err) =>
    console.error("[scan] failed:", err.message)
  );
  res.json({ ok: true });
});

app.get("/api/results", (req, res) => {
  const { jobId } = req.query;
  const all = listResults();
  const filtered = jobId
    ? all.filter((r) => String(r.jobId) === String(jobId))
    : all;
  filtered.sort((a, b) => {
    const ta = new Date(a.screenedAt || 0).getTime();
    const tb = new Date(b.screenedAt || 0).getTime();
    return tb - ta;
  });
  const enriched = filtered.map((r) => ({ ...r, outdated: isOutdated(r) }));
  res.json({
    results: enriched,
    currentPromptHash: jobId ? currentPromptHashFor(jobId) : null,
  });
});

app.post("/api/results/:id/override", (req, res) => {
  const existing = getResult(req.params.id);
  if (!existing) return res.status(404).json({ error: "Result not found" });
  const updated = saveResult(req.params.id, {
    decision: "KEEP",
    overridden: true,
  });
  res.json({ result: { id: req.params.id, ...updated } });
});

async function archiveOne(id) {
  const existing = getResult(id);
  if (!existing) throw new Error("Result not found");
  if (existing.archived) return existing;
  const settings = getSettings();
  if (!settings.polymerApiKey) throw new Error("Polymer API key not configured");
  await archiveApplication(settings.polymerApiKey, id);
  return saveResult(id, { archived: true, archivedAt: new Date().toISOString() });
}

app.post("/api/results/:id/archive", async (req, res) => {
  try {
    const updated = await archiveOne(req.params.id);
    res.json({ result: { id: req.params.id, ...updated } });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

app.post("/api/results/bulk-archive", async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids : null;
  const all = listResults();
  const targets = ids
    ? all.filter((r) => ids.includes(r.id))
    : all.filter(
        (r) => r.decision === "ARCHIVE" && !r.archived && !r.overridden
      );

  const results = [];
  for (const r of targets) {
    try {
      await archiveOne(r.id);
      results.push({ id: r.id, ok: true });
    } catch (err) {
      results.push({ id: r.id, ok: false, error: err.message });
    }
  }
  res.json({ archived: results.filter((r) => r.ok).length, results });
});

app.get("/api/history", (_req, res) => {
  const state = getState();
  res.json({ history: state.history || [] });
});

// --- static client (production) ---------------------------------------------

const clientDist = path.resolve(__dirnameInit, "..", "..", "client", "dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(clientDist, "index.html"));
  });
}

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

app.listen(PORT, () => {
  console.log(`Polymer ATS server listening on http://localhost:${PORT}`);
});
