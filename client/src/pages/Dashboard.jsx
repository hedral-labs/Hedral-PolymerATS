import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../api.js";

function ThinkingLog({ events, model, scanning }) {
  const [expanded, setExpanded] = useState({});
  // Only show actual screening events; bracket events ("scan_start", etc.)
  // get rendered as headers/footers.
  const screenEvents = events.filter((e) =>
    ["screen_start", "screen_done", "screen_error"].includes(e.type)
  );
  if (screenEvents.length === 0 && !scanning) return null;

  // Collapse consecutive start+done for the same id into a single row.
  const merged = [];
  const seenDone = new Set();
  for (const e of events) {
    if (e.type === "screen_done" || e.type === "screen_error") {
      merged.push(e);
      seenDone.add(e.id);
    } else if (e.type === "screen_start" && !seenDone.has(e.id)) {
      merged.push(e);
    }
  }

  function badgeClass(decision) {
    return decision === "ARCHIVE" ? "log-badge log-archive" : "log-badge log-keep";
  }

  return (
    <details className="panel thinking-log" open={scanning}>
      <summary>
        <span>Thinking log</span>
        <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
          {model || "claude"} · {merged.length} event{merged.length === 1 ? "" : "s"}
        </span>
      </summary>
      <div className="thinking-body">
        {merged.length === 0 ? (
          <div className="muted" style={{ padding: "12px 0", fontSize: 13 }}>Waiting for first candidate…</div>
        ) : (
          <ul className="log-list">
            {merged.map((e, idx) => {
              const time = new Date(e.ts).toLocaleTimeString();
              if (e.type === "screen_start") {
                return (
                  <li key={`${e.id}-start-${idx}`} className="log-row log-row-pending">
                    <span className="log-time">{time}</span>
                    <span className="log-name">{e.name}</span>
                    <span className="log-status muted">screening…</span>
                  </li>
                );
              }
              if (e.type === "screen_error") {
                return (
                  <li key={`${e.id}-err-${idx}`} className="log-row">
                    <span className="log-time">{time}</span>
                    <span className="log-name">{e.name}</span>
                    <span className="log-badge log-error">error</span>
                    <span className="log-reason muted">{e.error}</span>
                  </li>
                );
              }
              const key = `${e.id}-done-${idx}`;
              const isOpen = !!expanded[key];
              return (
                <li key={key} className="log-row">
                  <button
                    type="button"
                    className="log-row-button"
                    onClick={() => setExpanded((s) => ({ ...s, [key]: !s[key] }))}
                    aria-expanded={isOpen}
                  >
                    <span className="log-time">{time}</span>
                    <span className="log-name">{e.name}</span>
                    <span className={badgeClass(e.decision)}>{e.decision}</span>
                    <span className={`log-score confidence-${e.confidence || "low"}`}>
                      {e.confidence?.toUpperCase()}
                      {typeof e.score === "number" ? ` · ${e.score}` : ""}
                    </span>
                    <span className="log-reason">{e.reason}</span>
                    <span className="log-chevron">{isOpen ? "▾" : "▸"}</span>
                  </button>
                  {isOpen && (
                    <div className="log-detail">
                      {e.flags && e.flags.length > 0 && (
                        <div className="log-flags">
                          {e.flags.map((f) => (
                            <span key={f} className="flag">{f}</span>
                          ))}
                        </div>
                      )}
                      <div className="log-detail-meta muted">
                        {e.hasResumePdf ? "Resume PDF attached to prompt" : "No resume PDF"} · model {model}
                      </div>
                      {e.inputText && (
                        <pre className="log-input">{e.inputText}</pre>
                      )}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}

function formatRelative(iso) {
  if (!iso) return "—";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const mins = Math.round(abs / 60000);
  const hours = Math.round(mins / 60);
  const days = Math.round(hours / 24);
  let txt;
  if (mins < 1) txt = "moments";
  else if (mins < 60) txt = `${mins}m`;
  else if (hours < 48) txt = `${hours}h`;
  else txt = `${days}d`;
  return diff > 0 ? `in ${txt}` : `${txt} ago`;
}

export default function Dashboard({ status, refreshStatus }) {
  const [busy, setBusy] = useState(false);
  const [errMsg, setErrMsg] = useState(null);
  const [jobs, setJobs] = useState([]);
  const [loadingJobs, setLoadingJobs] = useState(false);
  const [jobsErr, setJobsErr] = useState(null);

  // prompt state for the active job
  const [promptInfo, setPromptInfo] = useState(null);
  const [prompt, setPrompt] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [promptSaving, setPromptSaving] = useState(false);
  const [promptMsg, setPromptMsg] = useState(null);

  async function loadJobs() {
    if (!status?.configured) return;
    setLoadingJobs(true);
    setJobsErr(null);
    try {
      const r = await api.listJobs();
      setJobs(r.jobs || []);
    } catch (e) {
      setJobsErr(e.message);
    } finally {
      setLoadingJobs(false);
    }
  }

  useEffect(() => {
    if (status?.configured) loadJobs();
  }, [status?.configured]);

  // Whenever the active job changes, load its prompt.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!status?.jobId) {
        setPromptInfo(null);
        setPrompt("");
        setPromptDirty(false);
        return;
      }
      try {
        const info = await api.getPrompt(status.jobId);
        if (cancelled) return;
        setPromptInfo(info);
        setPrompt(info.prompt || info.defaultPrompt || "");
        setPromptDirty(false);
        setPromptMsg(null);
      } catch (e) {
        if (!cancelled) setPromptMsg(e.message);
      }
    }
    load();
    return () => { cancelled = true; };
  }, [status?.jobId]);

  async function selectJob(jobId) {
    try {
      await api.saveSettings({ jobId });
      await refreshStatus();
    } catch (e) {
      setErrMsg(e.message);
    }
  }

  async function onScan() {
    setBusy(true);
    setErrMsg(null);
    try {
      await api.startScan({});
      await refreshStatus();
    } catch (err) {
      setErrMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onRescanOutdated() {
    setBusy(true);
    setErrMsg(null);
    try {
      await api.rescanOutdated();
      await refreshStatus();
    } catch (err) {
      setErrMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function onRescanAll() {
    if (!confirm("Re-screen every candidate for this job? This will re-run Claude on all of them.")) return;
    setBusy(true);
    setErrMsg(null);
    try {
      await api.rescanAll();
      await refreshStatus();
    } catch (err) {
      setErrMsg(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function savePrompt() {
    if (!status?.jobId) return;
    setPromptSaving(true);
    setPromptMsg(null);
    try {
      const usingDefault =
        prompt.trim() === (promptInfo?.defaultPrompt || "").trim();
      const info = await api.savePrompt(status.jobId, usingDefault ? null : prompt);
      setPromptInfo(info);
      setPrompt(info.prompt || info.defaultPrompt || "");
      setPromptDirty(false);
      setPromptMsg("Saved.");
    } catch (e) {
      setPromptMsg(e.message);
    } finally {
      setPromptSaving(false);
    }
  }

  async function resetPrompt() {
    if (!promptInfo) return;
    setPrompt(promptInfo.defaultPrompt || "");
    setPromptDirty(true);
    setPromptMsg(null);
  }

  if (!status) return <div className="empty">Loading…</div>;

  const stats = status.stats || { total: 0, flagged: 0, kept: 0, archived: 0 };
  const progress = status.progress;
  const progressPct = progress?.total ? (progress.current / progress.total) * 100 : 0;
  const activeJob = jobs.find((j) => j.id === status.jobId);
  const canScan = status.configured && !!status.jobId && !status.scanning && !busy;

  return (
    <div className="spaced">
      {!status.configured && (
        <div className="banner-inline banner-warn">
          <strong>API keys missing.</strong>{" "}
          Set <span className="inline-code">POLYMER_API_KEY</span> and{" "}
          <span className="inline-code">ANTHROPIC_API_KEY</span> in{" "}
          <span className="inline-code">.env</span>, then restart the server.
        </div>
      )}

      <section className="hero">
        <div className="hero-head">
          <div>
            <div className="eyebrow">Active job</div>
            <h1 className="hero-title">
              {activeJob ? activeJob.title : status.jobId ? `Job ${status.jobId}` : "No job selected"}
            </h1>
            <div className="hero-sub">
              {activeJob?.location ? `${activeJob.location} · ` : ""}
              {status.lastScanAt
                ? `Last scanned ${formatRelative(status.lastScanAt)}`
                : "Not yet scanned"}
              {status.nextScanAt && status.jobId ? (
                <> · Next auto-scan {formatRelative(status.nextScanAt)}</>
              ) : null}
            </div>
          </div>
          <div className="hero-actions">
            <button onClick={loadJobs} disabled={loadingJobs}>
              {loadingJobs ? "Refreshing…" : "Refresh jobs"}
            </button>
            {stats.outdated > 0 && (
              <button onClick={onRescanOutdated} disabled={!canScan}>
                Re-screen outdated ({stats.outdated})
              </button>
            )}
            {stats.total > 0 && (
              <button className="btn-ghost" onClick={onRescanAll} disabled={!canScan}>
                Re-scan all
              </button>
            )}
            <button className="btn-primary" onClick={onScan} disabled={!canScan}>
              {status.scanning ? "Scanning…" : "Run scan"}
            </button>
          </div>
        </div>

        <select
          value={status.jobId || ""}
          onChange={(e) => selectJob(e.target.value)}
          disabled={!status.configured || loadingJobs || jobs.length === 0}
          className="hero-select"
        >
          <option value="">
            {!status.configured
              ? "Configure API keys to load jobs"
              : loadingJobs
              ? "Fetching published jobs…"
              : jobs.length === 0
              ? "No active jobs — click Refresh jobs"
              : "— Select a job to screen —"}
          </option>
          {jobs.map((j) => (
            <option key={j.id} value={j.id}>
              {j.title} ({j.id}){j.location ? ` · ${j.location}` : ""}
            </option>
          ))}
        </select>

        {jobsErr && <div className="inline-error">{jobsErr}</div>}
        {errMsg && <div className="inline-error">{errMsg}</div>}
      </section>

      {status.scanning && (
        <div className="panel scan-progress">
          <div className="row-between">
            <strong>Screening</strong>
            <span className="muted">
              {progress?.current ?? 0} / {progress?.total ?? 0}
            </span>
          </div>
          <div className="muted" style={{ marginTop: 4 }}>
            {progress?.currentName || "Preparing…"}
          </div>
          <div className="progress"><div className="progress-fill" style={{ width: `${progressPct}%` }} /></div>
        </div>
      )}

      <ThinkingLog
        events={status.events || []}
        model={status.model}
        scanning={status.scanning}
      />


      <section className="cards">
        <div className="card">
          <div className="card-label">Screened</div>
          <div className="card-value">{stats.total}</div>
        </div>
        <div className="card">
          <div className="card-label">Flagged</div>
          <div className="card-value" style={{ color: "var(--warn)" }}>{stats.flagged}</div>
          {stats.flagged > 0 && (
            <div className="card-sub"><Link to="/review">Review queue →</Link></div>
          )}
        </div>
        <div className="card">
          <div className="card-label">Kept</div>
          <div className="card-value" style={{ color: "var(--ok)" }}>{stats.kept}</div>
        </div>
        <div className="card">
          <div className="card-label">Archived</div>
          <div className="card-value">{stats.archived}</div>
        </div>
        {stats.outdated > 0 && (
          <div className="card" style={{ borderColor: "rgba(227, 179, 65, 0.4)" }}>
            <div className="card-label" style={{ color: "var(--warn)" }}>Outdated criteria</div>
            <div className="card-value" style={{ color: "var(--warn)" }}>{stats.outdated}</div>
            <div className="card-sub">
              Screened under a different prompt — re-screen to refresh.
            </div>
          </div>
        )}
      </section>

      {status.jobId && (
        <details className="panel prompt-panel" open={false}>
          <summary>
            <span>Screening criteria</span>
            <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>
              {promptInfo?.isCustom ? "Customized for this job" : "Using default"}
            </span>
          </summary>
          <div className="prompt-body">
            <textarea
              value={prompt}
              onChange={(e) => {
                setPrompt(e.target.value);
                setPromptDirty(true);
              }}
            />
            <div className="row-between" style={{ marginTop: 10 }}>
              <div className="muted" style={{ fontSize: 12 }}>
                {promptMsg || (promptDirty ? "Unsaved changes" : "Saved per-job. Used on the next scan.")}
              </div>
              <div className="actions">
                <button type="button" className="btn-ghost" onClick={resetPrompt}>
                  Reset to default
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={savePrompt}
                  disabled={promptSaving || !promptDirty}
                >
                  {promptSaving ? "Saving…" : "Save criteria"}
                </button>
              </div>
            </div>
          </div>
        </details>
      )}
    </div>
  );
}
