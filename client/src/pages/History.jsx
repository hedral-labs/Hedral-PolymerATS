import { useEffect, useState } from "react";
import { api } from "../api.js";

function fmt(iso) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export default function History() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const r = await api.history();
      setRows(r.history || []);
      setErr(null);
    } catch (e) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, []);

  return (
    <div className="spaced">
      <div className="row-between">
        <h1 className="page-title">Scan history</h1>
        <button onClick={load} disabled={loading}>Refresh</button>
      </div>
      {err && <div className="panel" style={{ color: "var(--bad)" }}>{err}</div>}
      <div className="panel" style={{ padding: 0 }}>
        {rows.length === 0 ? (
          <div className="empty">No scans recorded yet.</div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Job</th>
                <th>Scanned</th>
                <th>Flagged</th>
                <th>Kept</th>
                <th>Archived</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={i}>
                  <td>{fmt(r.startedAt)}</td>
                  <td>{r.jobTitle || (r.jobId ? `Job ${r.jobId}` : "—")}</td>
                  <td>{r.scanned ?? 0}</td>
                  <td>{r.flagged ?? 0}</td>
                  <td>{r.kept ?? 0}</td>
                  <td>{r.archived ?? 0}</td>
                  <td>
                    {r.error ? (
                      <span className="pill pill-bad">Failed</span>
                    ) : r.finishedAt ? (
                      <span className="pill pill-ok">Done</span>
                    ) : (
                      <span className="pill pill-active">Running</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
