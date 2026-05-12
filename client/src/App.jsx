import { useEffect, useState } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { api } from "./api.js";
import Dashboard from "./pages/Dashboard.jsx";
import Review from "./pages/Review.jsx";
import History from "./pages/History.jsx";

export default function App() {
  const [status, setStatus] = useState(null);
  const [error, setError] = useState(null);

  async function refreshStatus() {
    try {
      const s = await api.status();
      setStatus(s);
      setError(null);
      return s;
    } catch (err) {
      setError(err.message);
      return null;
    }
  }

  useEffect(() => {
    refreshStatus();
    const id = setInterval(refreshStatus, 4000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" />
          <span>Polymer ATS Screener</span>
        </div>
        <nav className="nav">
          <NavLink to="/" end>Dashboard</NavLink>
          <NavLink to="/review">Review</NavLink>
          <NavLink to="/history">History</NavLink>
        </nav>
        <div className="topbar-meta">
          {status?.scanning ? (
            <span className="pill pill-active">
              Scanning {status.progress?.current ?? 0}/{status.progress?.total ?? 0}
            </span>
          ) : status?.configured ? (
            <span className="pill pill-ok">Ready</span>
          ) : (
            <span className="pill pill-warn">Keys missing</span>
          )}
        </div>
      </header>

      {error && <div className="banner banner-error">{error}</div>}

      <main className="main">
        <Routes>
          <Route path="/" element={<Dashboard status={status} refreshStatus={refreshStatus} />} />
          <Route path="/review" element={<Review status={status} refreshStatus={refreshStatus} />} />
          <Route path="/history" element={<History />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}
