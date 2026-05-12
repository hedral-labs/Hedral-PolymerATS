# Polymer ATS Screener

A small React + Express app that connects to the Polymer hiring API, uses
Claude (Sonnet 4) to screen applicants — including reading their resume
PDFs — and lets you review and archive candidates who don't pass.

Built so each teammate can clone it, point it at one of the jobs they manage
in Polymer, edit the screening criteria for that job, and trigger scans on
demand. There's also a weekly background scan so the pipeline stays fresh
without anyone clicking anything.

Auth (WorkOS) is not wired up yet — for now run locally or behind a private
deployment.

## Architecture

```
client/  React + Vite UI (Dashboard, Review queue, History)
server/  Express API + Polymer proxy + Claude screening loop + scheduler
         data/db.json — local JSON store: settings, results, history, prompts
```

All Polymer and Anthropic API calls happen on the server. The browser only
talks to `/api/*`; it never holds either API key.

## First-time setup

```bash
# 1. Install everything
npm run install:all

# 2. Copy the env template and fill in your own keys
cp .env.example .env
# Edit .env: set POLYMER_API_KEY and ANTHROPIC_API_KEY
# (the job is picked from the UI — not configured here)

# 3. Start both server and client in dev mode
npm run dev
```

- Server: http://localhost:3001
- Client (Vite dev): http://localhost:5173 (proxies `/api/*` → server)

On boot, the server loads `POLYMER_API_KEY` and `ANTHROPIC_API_KEY` from
`.env` (overriding any inherited shell values — see the dotenv override in
`server/src/index.js`). The Dashboard fetches your published Polymer jobs;
pick one and click **Run scan** to start.

## How a scan works

The Dashboard's **Run scan** button does the following on the server:

1. **List applications.** `GET /v1/hire/job_applications?job_id=…` (paginated
   50 per page) until Polymer returns fewer than a full page.
2. **Filter the queue.** By default, applicants already in the local DB are
   skipped — only *new* applicants are screened. (You can override this; see
   "Re-scan controls" below.)
3. **Screen in parallel.** Up to **5 candidates** are screened concurrently
   (configurable via `SCAN_CONCURRENCY` in `server/src/scanner.js`). For each
   candidate, the server:
   - **Fetches the resume PDF** (up to 8 MB) from Polymer's blob URL.
   - Sends Claude Sonnet 4 a single message with the resume as a `document`
     content block plus a text block containing the candidate's name,
     location, LinkedIn, email, and application question responses.
   - Asks Claude to return strict JSON:
     ```json
     {
       "decision": "KEEP" | "ARCHIVE",
       "confidence": "high" | "medium" | "low",
       "score": 0-100,
       "reason": "one sentence",
       "flags": ["short", "tags"]
     }
     ```
   - Persists the result with a `promptHash` (sha256 prefix of the prompt
     used) so we know later if the criteria has drifted.
4. **Update progress.** The UI polls `/api/status` every few seconds and
   shows real-time progress (`current / total`, currently-screening name,
   progress bar).

A 221-applicant first scan typically completes in **2-3 minutes** with
concurrency 5; without concurrency the same scan took ~10 minutes.

### Safety rules baked into screening

- **Nothing is auto-archived.** Claude only *recommends* archive — you have
  to click Archive (per-row) or Archive all flagged in the Review queue for
  Polymer to actually be called.
- **Low-confidence ARCHIVE is auto-downgraded to KEEP** with a
  `low_confidence_archive_downgraded` flag, so soft signals don't quietly
  flush people from the pipeline.
- **Errors don't crash a scan.** If Claude or Polymer fails for one
  candidate, that result is saved as `KEEP/low/error` and the loop moves on.
- **PDF fetch failures fall back gracefully.** If Polymer's blob URL is
  unreachable or the file isn't a PDF, the candidate is still screened
  using their text profile only — just with weaker signal. A warning is
  logged to the server console.

## Per-job screening criteria

The screening prompt lives **per job**, not globally. Open the **Screening
criteria** section on the Dashboard while a job is selected to edit it.
Each job gets its own customized prompt persisted in `server/data/db.json`
under `prompts[<jobId>]`; if you've never customized it, the built-in
default is used.

What you write here is **only the natural-language rubric** — who to keep,
who to archive, judgment rules. The server appends a fixed
JSON-output-schema instruction at send-time (`OUTPUT_SCHEMA_SUFFIX` in
`server/src/screener.js`). The schema isn't user-editable and doesn't
participate in the prompt hash, so internal schema tweaks don't make every
existing result look "outdated".

## Thinking log

While a scan is running (and for a short period after), the Dashboard shows
a collapsible **Thinking log** panel listing every candidate the server has
touched: timestamp, name, decision, confidence + score, one-line reason.
Click any completed row to expand and see the flags + the exact text that
was sent to Claude for that applicant. The log is the last ~60 events held
in memory; it resets at the start of each new scan.

### Outdated-criteria detection

Each saved result records the hash of the prompt that produced it. When you
edit the prompt and save, every previously-scanned candidate for that job
becomes "outdated" — visible as:

- An **Outdated criteria** stat card on the Dashboard (with count).
- A banner at the top of the **Review** page.
- A per-row `outdated criteria` pill next to each affected candidate.

Nothing re-runs automatically — you decide when to refresh.

## Re-scan controls

Three buttons appear on the Dashboard depending on state:

| Button                       | What it does                                                                 |
| ---------------------------- | ---------------------------------------------------------------------------- |
| **Run scan**                 | Default. Screens only *new* applicants (not already in the DB).              |
| **Re-screen outdated (N)**   | Visible only when the prompt has drifted. Re-screens only outdated results.  |
| **Re-scan all**              | Confirmation dialog → re-screens every candidate for the active job.         |

All three go through `POST /api/scan` with different flags (`{}`,
`{ onlyOutdated: true }`, `{ rescreenAll: true }`).

## Weekly auto-scan

Whenever a job is selected and both API keys are configured, the server
schedules the next scan for **7 days** after the most recent one. A cron
job ticks hourly and runs the scan as soon as `nextScanAt` elapses; it
seeds the timer if it's empty. The cadence is fixed in code
(`SCAN_INTERVAL_DAYS = 7` in `server/src/scheduler.js`) — not exposed in
the UI to keep things simple.

After every scan (manual or scheduled), `nextScanAt` rolls 7 days forward.
So a manual mid-week scan effectively resets the weekly clock.

## Review queue

The Review page lives at `/review`. It shows three sections, all filtered to
the active job:

- **Flagged for archive** — `ARCHIVE` decisions that haven't been archived
  or overridden yet. Each row has:
  - Name, location, email
  - One-sentence reason from Claude
  - Confidence badge + numeric score (e.g. `HIGH · 85`)
  - Any flags (e.g. `body-shop`, `TCS`, `low_confidence_archive_downgraded`)
  - Resume + LinkedIn links
  - **Archive** / **Override → Keep** buttons
- **Cleared (kept)** — what Claude recommended keeping (plus anything you
  manually overrode).
- **Archived** — already archived via Polymer.

A bulk **Archive all flagged** button at the top archives everything in the
flagged section in one call (one Polymer API call per candidate, results
shown after).

## Production build

```bash
npm run build      # client/dist
npm start          # server serves API + static client (port 3001)
```

The server auto-serves `client/dist/` if it exists, so a single Node process
is enough for deployment to Azure App Service / AWS App Runner / Fly /
Render. WorkOS auth can be slotted in front of Express later without any
app-logic changes.

## Sharing with teammates

1. Push the repo to your org.
2. Each teammate clones it, runs `npm run install:all`, and creates their
   own `.env` with their own Polymer key + Anthropic key.
3. They pick their job from the Dashboard dropdown and (optionally) tweak
   the screening criteria for that job. Each instance keeps its own state
   in `server/data/db.json` (git-ignored).

## API surface

| Method | Path                              | Purpose                                                         |
| ------ | --------------------------------- | --------------------------------------------------------------- |
| GET    | `/api/status`                     | Dashboard state — stats, progress, last/next scan, outdated cnt |
| GET    | `/api/settings`                   | Settings (API keys masked, current active jobId)                |
| PUT    | `/api/settings`                   | Update active jobId                                             |
| GET    | `/api/jobs`                       | Proxy: list active/published Polymer jobs                       |
| GET    | `/api/prompts/:jobId`             | Custom prompt for a job (+ default + current hash)              |
| PUT    | `/api/prompts/:jobId`             | Save a custom prompt for a job (null reverts to default)        |
| POST   | `/api/scan`                       | Body: `{ rescreenAll?, onlyOutdated? }`. Async fire-and-forget. |
| GET    | `/api/results?jobId=…`            | All screened candidates for a job, each tagged with `outdated`  |
| POST   | `/api/results/:id/override`       | Mark a flagged candidate as Keep                                |
| POST   | `/api/results/:id/archive`        | Archive via Polymer                                             |
| POST   | `/api/results/bulk-archive`       | Archive every currently-flagged candidate                       |
| GET    | `/api/history`                    | Past scans (start/end, counts, jobId, jobTitle, errors)         |

## Local data

Everything the server learns or remembers lives in
`server/data/db.json`. It's git-ignored. The structure:

```json
{
  "settings":  { "polymerApiKey": "", "anthropicApiKey": "", "jobId": "" },
  "prompts":   { "<jobId>": "custom prompt string" },
  "jobMeta":   { "<jobId>": { "title": "…", "location": "…" } },
  "lastScanAt": "ISO",
  "nextScanAt": "ISO",
  "scanning":   false,
  "scanProgress": { "current": 0, "total": 0, "currentName": null },
  "results": {
    "<applicationId>": {
      "jobId": "…",
      "applicant": { "name": "…", "email": "…", ... },
      "decision": "KEEP|ARCHIVE",
      "confidence": "high|medium|low",
      "score": 0-100,
      "reason": "…",
      "flags": ["…"],
      "promptHash": "16-char sha256 prefix",
      "screenedAt": "ISO",
      "overridden": false,
      "archived": false,
      "error": null
    }
  },
  "history": [
    { "startedAt": "ISO", "finishedAt": "ISO", "jobId": "…", "jobTitle": "…",
      "scanned": 0, "flagged": 0, "kept": 0, "archived": 0, "error": null }
  ]
}
```

Safe to delete to start fresh — the file will be recreated on the next boot.
