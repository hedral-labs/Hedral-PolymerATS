import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";

// Polymer's hire UI uses hash_ids in the path. Fall back to numeric IDs if
// the result was saved before we started persisting hashes.
function polymerCandidateUrl(applicant) {
  const job = applicant.jobHashId || applicant.jobId;
  const app = applicant.hashId || applicant.id;
  if (!job || !app) return null;
  return `https://app.polymer.co/hire/jobs/${job}/applications/${app}`;
}

function ConfidenceBadge({ value, score }) {
  const cls = `confidence-${value || "low"}`;
  const label = (value || "low").toUpperCase();
  return (
    <span className={`flag ${cls}`}>
      {label}
      {typeof score === "number" ? ` · ${score}` : ""}
    </span>
  );
}

function Candidate({ result, onArchive, onKeep, onPreview, busy }) {
  const a = result.applicant || {};
  return (
    <div className="candidate">
      <div>
        <h3>
          {a.name || "Unknown"}
          {result.outdated && (
            <span className="flag" style={{ marginLeft: 8, color: "var(--warn)", borderColor: "rgba(227,179,65,0.4)", background: "rgba(227,179,65,0.08)" }}>
              outdated criteria
            </span>
          )}
        </h3>
        <div className="meta">
          {a.location || "Unknown location"}
          {a.email ? ` · ${a.email}` : ""}
        </div>
        <div className="reason">{result.reason}</div>
        <div className="flags">
          <ConfidenceBadge value={result.confidence} score={result.score} />
          {(result.flags || []).map((f) => (
            <span key={f} className="flag">{f}</span>
          ))}
        </div>
        <div className="candidate-links">
          {a.resumeUrl && (
            <button
              type="button"
              className="link-button"
              onClick={() => onPreview(result)}
            >
              Resume
            </button>
          )}
          {a.linkedinUrl && <a href={a.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn</a>}
          {polymerCandidateUrl(a) && (
            <a href={polymerCandidateUrl(a)} target="_blank" rel="noreferrer">
              Open in Polymer ↗
            </a>
          )}
        </div>
      </div>
      <div className="candidate-actions">
        {result.archived ? (
          <span className="pill">Archived</span>
        ) : (
          <>
            <button
              className="btn-danger"
              onClick={() => onArchive(result.id)}
              disabled={busy}
            >
              Archive
            </button>
            <button
              className="btn-ghost"
              onClick={() => onKeep(result.id)}
              disabled={busy}
            >
              Override → Keep
            </button>
          </>
        )}
      </div>
    </div>
  );
}

function ResumePanel({ result, onClose, onArchive, onKeep, busy }) {
  const a = result.applicant || {};
  // Route the PDF through our server so we sidestep any X-Frame-Options
  // restrictions Polymer might set, and so the browser renders inline.
  // PDF Open Parameters: hide the thumbnail sidebar (navpanes=0), keep the
  // top toolbar so the user can zoom/download/print, and fit horizontally
  // so we don't open at 46% zoom.
  const src = a.resumeUrl
    ? `/api/proxy/resume?url=${encodeURIComponent(a.resumeUrl)}#toolbar=1&navpanes=0&view=FitH`
    : null;

  useEffect(() => {
    function onKey(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  return (
    <>
      <div className="preview-overlay" onClick={onClose} />
      <aside className="preview-panel" role="dialog" aria-label="Resume preview">
        <header className="preview-head">
          <div>
            <h2 className="preview-title">{a.name || "Unknown"}</h2>
            <div className="muted preview-sub">
              {a.location || "Unknown location"}
              {a.email ? ` · ${a.email}` : ""}
            </div>
          </div>
          <button className="btn-ghost preview-close" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="preview-meta">
          <span className={`flag confidence-${result.confidence || "low"}`}>
            {(result.confidence || "low").toUpperCase()}
            {typeof result.score === "number" ? ` · ${result.score}` : ""}
          </span>
          <span className={`flag ${result.decision === "ARCHIVE" ? "log-archive" : "log-keep"}`}>
            {result.decision}
          </span>
          {(result.flags || []).map((f) => (
            <span key={f} className="flag">{f}</span>
          ))}
        </div>
        {result.reason && <div className="preview-reason">{result.reason}</div>}

        <div className="preview-pdf">
          {src ? (
            <iframe src={src} title={`${a.name} resume`} />
          ) : (
            <div className="empty">No resume attached.</div>
          )}
        </div>

        <footer className="preview-foot">
          {a.linkedinUrl && (
            <a href={a.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn ↗</a>
          )}
          {polymerCandidateUrl(a) && (
            <a href={polymerCandidateUrl(a)} target="_blank" rel="noreferrer">
              Open in Polymer ↗
            </a>
          )}
          <div className="actions" style={{ marginLeft: "auto" }}>
            {!result.archived && (
              <>
                <button
                  className="btn-ghost"
                  onClick={() => onKeep(result.id)}
                  disabled={busy}
                >
                  Override → Keep
                </button>
                <button
                  className="btn-danger"
                  onClick={() => onArchive(result.id)}
                  disabled={busy}
                >
                  Archive
                </button>
              </>
            )}
          </div>
        </footer>
      </aside>
    </>
  );
}

export default function Review({ status, refreshStatus }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [previewing, setPreviewing] = useState(null);

  async function refresh() {
    setLoading(true);
    try {
      const r = await api.listResults(status?.jobId || undefined);
      setResults(r.results || []);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!status) return;
    refresh();
    // poll while scanning
    if (status.scanning) {
      const id = setInterval(refresh, 4000);
      return () => clearInterval(id);
    }
  }, [status?.jobId, status?.scanning]);

  // Hide archived candidates entirely from the review queue — once someone
  // is archived (here or in Polymer) they're out of the active pipeline.
  const visible = useMemo(() => results.filter((r) => !r.archived), [results]);
  const flagged = useMemo(
    () => visible.filter((r) => r.decision === "ARCHIVE" && !r.overridden),
    [visible]
  );
  const kept = useMemo(
    () => visible.filter((r) => r.decision === "KEEP" || r.overridden),
    [visible]
  );

  async function archiveOne(id) {
    setBusy(true);
    try {
      await api.archive(id);
      await refresh();
      await refreshStatus();
      // archived candidates are hidden from the queue → close the preview
      setPreviewing(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function keepOne(id) {
    setBusy(true);
    try {
      await api.override(id);
      await refresh();
      await refreshStatus();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function rescreenOutdated() {
    setBusy(true);
    try {
      await api.rescanOutdated();
      await refreshStatus();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function archiveAll() {
    if (!flagged.length) return;
    if (!confirm(`Archive ${flagged.length} flagged candidate(s)?`)) return;
    setBusy(true);
    try {
      await api.bulkArchive();
      await refresh();
      await refreshStatus();
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="spaced">
      <div className="row-between">
        <h1 className="page-title">Review queue</h1>
        <div className="actions">
          <button onClick={refresh} disabled={loading}>Refresh</button>
          <button className="btn-danger" onClick={archiveAll} disabled={busy || !flagged.length}>
            Archive all flagged ({flagged.length})
          </button>
        </div>
      </div>

      {err && <div className="panel" style={{ color: "var(--bad)" }}>{err}</div>}

      {(() => {
        const outdatedCount = results.filter((r) => r.outdated).length;
        if (outdatedCount === 0) return null;
        return (
          <div className="banner-inline banner-warn">
            <div className="row-between">
              <div>
                <strong>{outdatedCount}</strong> candidate{outdatedCount === 1 ? " was" : "s were"} screened with outdated criteria.
                Re-screen them with your current prompt to refresh decisions.
              </div>
              <button onClick={rescreenOutdated} disabled={busy || status?.scanning}>
                Re-screen outdated
              </button>
            </div>
          </div>
        );
      })()}

      <div className="section-title">Flagged for archive — {flagged.length}</div>
      {flagged.length === 0 ? (
        <div className="empty">No flagged candidates. Run a scan from the dashboard.</div>
      ) : (
        <div className="candidate-list">
          {flagged.map((r) => (
            <Candidate
              key={r.id}
              result={r}
              onArchive={archiveOne}
              onKeep={keepOne}
              onPreview={setPreviewing}
              busy={busy}
            />
          ))}
        </div>
      )}

      <div className="section-title">Cleared (kept) — {kept.length}</div>
      {kept.length === 0 ? (
        <div className="empty muted">None yet.</div>
      ) : (
        <div className="candidate-list">
          {kept.map((r) => (
            <Candidate
              key={r.id}
              result={r}
              onArchive={archiveOne}
              onKeep={keepOne}
              onPreview={setPreviewing}
              busy={busy}
            />
          ))}
        </div>
      )}

      {previewing && (() => {
        // Always use the freshest copy of the result (so the panel reflects
        // overrides / archived-state updates triggered from inside it).
        const fresh = results.find((r) => r.id === previewing.id) || previewing;
        return (
          <ResumePanel
            result={fresh}
            onClose={() => setPreviewing(null)}
            onArchive={archiveOne}
            onKeep={keepOne}
            busy={busy}
          />
        );
      })()}
    </div>
  );
}
