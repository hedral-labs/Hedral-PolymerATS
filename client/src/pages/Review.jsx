import { useEffect, useMemo, useState } from "react";
import { api } from "../api.js";

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

function Candidate({ result, onArchive, onKeep, busy }) {
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
          {a.resumeUrl && <a href={a.resumeUrl} target="_blank" rel="noreferrer">Resume</a>}
          {a.linkedinUrl && <a href={a.linkedinUrl} target="_blank" rel="noreferrer">LinkedIn</a>}
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

export default function Review({ status, refreshStatus }) {
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

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

  const flagged = useMemo(
    () => results.filter((r) => r.decision === "ARCHIVE" && !r.archived && !r.overridden),
    [results]
  );
  const archived = useMemo(() => results.filter((r) => r.archived), [results]);
  const kept = useMemo(
    () => results.filter((r) => r.decision === "KEEP" || r.overridden),
    [results]
  );

  async function archiveOne(id) {
    setBusy(true);
    try {
      await api.archive(id);
      await refresh();
      await refreshStatus();
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
              busy={busy}
            />
          ))}
        </div>
      )}

      <div className="section-title">Archived — {archived.length}</div>
      {archived.length === 0 ? (
        <div className="empty muted">None yet.</div>
      ) : (
        <div className="candidate-list">
          {archived.map((r) => (
            <Candidate
              key={r.id}
              result={r}
              onArchive={archiveOne}
              onKeep={keepOne}
              busy={busy}
            />
          ))}
        </div>
      )}
    </div>
  );
}
