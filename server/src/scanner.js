import { listAllApplications } from "./polymer.js";
import {
  DEFAULT_CRITERIA,
  hashPrompt,
  normalizeApplicant,
  screenCandidate,
  shouldSkipApplication,
  stripOutputSpec,
} from "./screener.js";

export const SCAN_MODEL = "claude-sonnet-4-20250514";

// Ring buffer of recent scan events so the UI can render a live "thinking
// log" without us having to stream from the server.
const MAX_LOG = 60;
const eventLog = [];
function pushEvent(evt) {
  eventLog.unshift({ ts: new Date().toISOString(), ...evt });
  if (eventLog.length > MAX_LOG) eventLog.length = MAX_LOG;
}
export function getEventLog() {
  return eventLog;
}
function clearEventLog() {
  eventLog.length = 0;
}
import {
  getResult,
  getSettings,
  recordScanStart,
  saveResult,
  setLastScan,
  setScanState,
  updateLatestHistory,
  getPrompt,
  getJobMeta,
} from "./store.js";

let activeScan = null;

// Run up to N applicants through Claude in parallel. Sonnet 4's standard-tier
// limits comfortably absorb this; bump or lower here if your tier differs.
export const SCAN_CONCURRENCY = 5;

async function pMap(items, mapper, concurrency) {
  let cursor = 0;
  const errors = [];
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= items.length) return;
      try {
        await mapper(items[i], i);
      } catch (err) {
        // mapper is expected to handle its own errors; safety net only
        errors.push(err);
        console.error("[scan] worker uncaught:", err.message);
      }
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return errors;
}

export function isScanning() {
  return activeScan !== null;
}

export async function runScan({ jobId, rescreenAll = false, onlyOutdated = false } = {}) {
  if (activeScan) {
    return activeScan;
  }
  const settings = getSettings();
  const targetJobId = jobId || settings.jobId;
  if (!targetJobId) throw new Error("No job ID configured");
  if (!settings.polymerApiKey) throw new Error("Polymer API key not configured");
  if (!settings.anthropicApiKey)
    throw new Error("Anthropic API key not configured");

  const meta = getJobMeta(targetJobId);
  const history = recordScanStart({ jobId: targetJobId, jobTitle: meta?.title || null });
  setScanState({ scanning: true, progress: { current: 0, total: 0, currentName: null } });

  activeScan = (async () => {
    try {
      const criteria = stripOutputSpec(getPrompt(targetJobId) || DEFAULT_CRITERIA);
      const promptHash = hashPrompt(criteria);
      clearEventLog();
      pushEvent({
        type: "scan_start",
        jobId: targetJobId,
        model: SCAN_MODEL,
        promptHash,
      });
      console.log(
        `[scan] start jobId=${targetJobId} rescreenAll=${rescreenAll} onlyOutdated=${onlyOutdated} promptHash=${promptHash}`
      );

      const applications = await listAllApplications(
        settings.polymerApiKey,
        targetJobId
      );
      console.log(`[scan] fetched ${applications.length} application(s) from Polymer`);

      // Decide which applicants to (re)screen.
      const queue = [];
      let droppedNoId = 0;
      let droppedAlready = 0;
      let droppedArchived = 0;
      let reconciledArchived = 0;
      for (const app of applications) {
        // Skip applications already archived/rejected/anonymized in Polymer.
        const skipCheck = shouldSkipApplication(app);
        if (skipCheck.skip) {
          droppedArchived += 1;
          // If we have a local result for this app, mark it archived so it
          // moves out of the active review queue and into the archived list.
          const tentative = normalizeApplicant(app);
          if (tentative.id) {
            const existing = getResult(tentative.id);
            if (existing && !existing.archived) {
              saveResult(tentative.id, {
                archived: true,
                archivedAt: new Date().toISOString(),
              });
              reconciledArchived += 1;
            }
          }
          continue;
        }
        const candidate = normalizeApplicant(app);
        if (!candidate.id) { droppedNoId += 1; continue; }
        const existing = getResult(candidate.id);
        if (existing && !existing.error) {
          if (rescreenAll) {
            // re-screen everyone
          } else if (onlyOutdated && existing.promptHash !== promptHash) {
            // re-screen only those scanned under a different prompt
          } else {
            droppedAlready += 1;
            continue;
          }
        }
        queue.push(candidate);
      }
      console.log(
        `[scan] queued ${queue.length} to screen (skipped: ${droppedAlready} already-screened, ${droppedArchived} archived/anonymized in Polymer, ${droppedNoId} missing-id, reconciled ${reconciledArchived} previously-screened → archived)`
      );
      pushEvent({
        type: "queue_built",
        queued: queue.length,
        skippedAlreadyScreened: droppedAlready,
        skippedArchived: droppedArchived,
        skippedNoId: droppedNoId,
        reconciledArchived,
      });

      setScanState({
        scanning: true,
        progress: { current: 0, total: queue.length, currentName: null },
      });

      let flagged = 0;
      let kept = 0;
      let completed = 0;
      const inFlight = new Set();

      async function screenOne(candidate) {
        inFlight.add(candidate.name);
        pushEvent({
          type: "screen_start",
          id: candidate.id,
          name: candidate.name,
          location: candidate.location,
          hasResumeUrl: !!candidate.resumeUrl,
        });
        setScanState({
          scanning: true,
          progress: {
            current: completed,
            total: queue.length,
            currentName: candidate.name,
          },
        });
        try {
          const result = await screenCandidate({
            candidate,
            apiKey: settings.anthropicApiKey,
            model: SCAN_MODEL,
            criteria,
          });
          if (result.decision === "ARCHIVE") flagged += 1;
          else kept += 1;
          pushEvent({
            type: "screen_done",
            id: candidate.id,
            name: candidate.name,
            decision: result.decision,
            confidence: result.confidence,
            score: result.score ?? null,
            reason: result.reason,
            flags: result.flags || [],
            hasResumePdf: !!result.hasResumePdf,
            inputText: result.userText || null,
          });
          saveResult(candidate.id, {
            jobId: candidate.jobId || targetJobId,
            applicant: {
              id: candidate.id,
              name: candidate.name,
              email: candidate.email,
              location: candidate.location,
              linkedinUrl: candidate.linkedinUrl,
              resumeUrl: candidate.resumeUrl,
              appliedAt: candidate.appliedAt,
              status: candidate.status,
            },
            decision: result.decision,
            confidence: result.confidence,
            score: result.score ?? null,
            reason: result.reason,
            flags: result.flags,
            promptHash,
            screenedAt: new Date().toISOString(),
            overridden: false,
            archived: false,
            error: null,
          });
          console.log(
            `[scan] ${completed + 1}/${queue.length} ${candidate.name} → ${result.decision} (${result.confidence}${result.score != null ? `, ${result.score}` : ""})`
          );
        } catch (err) {
          console.error(`[scan] ${candidate.name} failed:`, err.message);
          pushEvent({
            type: "screen_error",
            id: candidate.id,
            name: candidate.name,
            error: err.message,
          });
          saveResult(candidate.id, {
            jobId: candidate.jobId || targetJobId,
            applicant: {
              id: candidate.id,
              name: candidate.name,
              email: candidate.email,
              location: candidate.location,
              linkedinUrl: candidate.linkedinUrl,
              resumeUrl: candidate.resumeUrl,
            },
            decision: "KEEP",
            confidence: "low",
            score: null,
            reason: `Screening failed: ${err.message}`,
            flags: ["error"],
            promptHash,
            screenedAt: new Date().toISOString(),
            error: err.message,
          });
        } finally {
          completed += 1;
          inFlight.delete(candidate.name);
          // pick any name still being screened to show, otherwise blank
          const stillRunning = inFlight.values().next().value || null;
          setScanState({
            scanning: true,
            progress: {
              current: completed,
              total: queue.length,
              currentName: stillRunning,
            },
          });
          updateLatestHistory({ scanned: completed, flagged, kept });
        }
      }

      await pMap(queue, screenOne, SCAN_CONCURRENCY);

      const finishedAt = new Date().toISOString();
      setLastScan(finishedAt);
      updateLatestHistory({
        scanned: queue.length,
        flagged,
        kept,
        finishedAt,
      });
      console.log(`[scan] DONE scanned=${queue.length} flagged=${flagged} kept=${kept}`);
      pushEvent({ type: "scan_done", scanned: queue.length, flagged, kept });
      return { scanned: queue.length, flagged, kept };
    } catch (err) {
      console.error(`[scan] FAILED:`, err.message);
      pushEvent({ type: "scan_error", error: err.message });
      updateLatestHistory({
        finishedAt: new Date().toISOString(),
        error: err.message,
      });
      throw err;
    } finally {
      setScanState({ scanning: false, progress: null });
      activeScan = null;
    }
  })();
  return activeScan;
}
