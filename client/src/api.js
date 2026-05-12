async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const msg = (data && data.error) || `Request failed: ${res.status}`;
    throw new Error(msg);
  }
  return data;
}

export const api = {
  status: () => request("/api/status"),
  getSettings: () => request("/api/settings"),
  saveSettings: (patch) => request("/api/settings", { method: "PUT", body: patch }),
  listJobs: () => request("/api/jobs"),
  getPrompt: (jobId) => request(`/api/prompts/${encodeURIComponent(jobId)}`),
  savePrompt: (jobId, prompt) =>
    request(`/api/prompts/${encodeURIComponent(jobId)}`, {
      method: "PUT",
      body: { prompt },
    }),
  startScan: (body = {}) => request("/api/scan", { method: "POST", body }),
  rescanAll: () => request("/api/scan", { method: "POST", body: { rescreenAll: true } }),
  rescanOutdated: () => request("/api/scan", { method: "POST", body: { onlyOutdated: true } }),
  listResults: (jobId) =>
    request(`/api/results${jobId ? `?jobId=${encodeURIComponent(jobId)}` : ""}`),
  override: (id) => request(`/api/results/${id}/override`, { method: "POST" }),
  archive: (id) => request(`/api/results/${id}/archive`, { method: "POST" }),
  bulkArchive: (ids) =>
    request(`/api/results/bulk-archive`, {
      method: "POST",
      body: ids ? { ids } : {},
    }),
  history: () => request("/api/history"),
};
