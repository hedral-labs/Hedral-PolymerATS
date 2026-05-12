import cron from "node-cron";
import { getSettings, getState, setNextScan } from "./store.js";
import { isScanning, runScan } from "./scanner.js";

const SCAN_INTERVAL_DAYS = 7;
const SCAN_INTERVAL_MS = SCAN_INTERVAL_DAYS * 24 * 60 * 60 * 1000;

let task = null;

function shouldRunNow() {
  const state = getState();
  if (isScanning()) return false;
  if (!state.nextScanAt) return false;
  return new Date(state.nextScanAt).getTime() <= Date.now();
}

export function startScheduler() {
  if (task) return;
  // Tick hourly; the cadence is enforced by nextScanAt (rolled forward after each scan).
  task = cron.schedule("0 * * * *", async () => {
    const settings = getSettings();
    if (!settings.polymerApiKey || !settings.anthropicApiKey || !settings.jobId) return;
    if (!shouldRunNow()) return;
    try {
      console.log("[scheduler] Auto-scan starting…");
      await runScan({});
      console.log("[scheduler] Auto-scan finished");
    } catch (err) {
      console.error("[scheduler] Auto-scan failed:", err.message);
      // re-arm so we retry on the next interval rather than spamming
      setNextScan(new Date(Date.now() + SCAN_INTERVAL_MS).toISOString());
    }
  });

  // Seed nextScanAt the first time we have what we need.
  const state = getState();
  const settings = getSettings();
  if (!state.nextScanAt && settings.polymerApiKey && settings.jobId) {
    setNextScan(new Date(Date.now() + SCAN_INTERVAL_MS).toISOString());
  }
}

export { SCAN_INTERVAL_DAYS, SCAN_INTERVAL_MS };
