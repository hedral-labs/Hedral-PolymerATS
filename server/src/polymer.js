const BASE_URL = "https://api.polymer.co/v1/hire";

function headers(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function request(apiKey, path, { method = "GET", body } = {}) {
  if (!apiKey) throw new Error("Polymer API key not configured");
  const url = `${BASE_URL}${path}`;
  console.log(`[polymer] ${method} ${url}`);
  const res = await fetch(url, {
    method,
    headers: headers(apiKey),
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }
  console.log(
    `[polymer] ← ${res.status} ${res.statusText}; keys=${
      data && typeof data === "object" && !Array.isArray(data)
        ? Object.keys(data).join(",")
        : Array.isArray(data)
        ? `array(len=${data.length})`
        : typeof data
    }`
  );
  if (!res.ok) {
    const msg =
      (data && (data.message || data.error)) ||
      `Polymer API ${res.status} ${res.statusText}`;
    const err = new Error(msg);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

export async function listJobs(apiKey, { status = "published" } = {}) {
  const data = await request(
    apiKey,
    `/jobs?status=${encodeURIComponent(status)}`
  );
  let items;
  if (Array.isArray(data)) items = data;
  else if (Array.isArray(data?.jobs)) items = data.jobs;
  else if (Array.isArray(data?.data)) items = data.data;
  else if (Array.isArray(data?.results)) items = data.results;
  else if (Array.isArray(data?.items)) items = data.items;
  else items = [];
  console.log(`[polymer] listJobs normalized count=${items.length}`);
  return { items, raw: data };
}

export async function listApplications(apiKey, jobId, { page = 1, perPage = 50 } = {}) {
  const data = await request(
    apiKey,
    `/job_applications?job_id=${encodeURIComponent(jobId)}&page=${page}&per_page=${perPage}`
  );
  // Polymer responses vary by account; normalize.
  let items;
  if (Array.isArray(data)) items = data;
  else if (Array.isArray(data?.job_applications)) items = data.job_applications;
  else if (Array.isArray(data?.applications)) items = data.applications;
  else if (Array.isArray(data?.data)) items = data.data;
  else if (Array.isArray(data?.results)) items = data.results;
  else if (Array.isArray(data?.items)) items = data.items;
  else items = [];
  const meta = data?.meta || data?.pagination || null;
  console.log(`[polymer] listApplications jobId=${jobId} page=${page} → ${items.length} item(s)`);
  if (page === 1 && items.length === 0 && data && typeof data === "object") {
    console.log(`[polymer]   raw response keys: ${Object.keys(data).join(",") || "(none)"}`);
  }
  return { items, meta, raw: data };
}

export async function listAllApplications(apiKey, jobId) {
  const all = [];
  const perPage = 50;
  let page = 1;
  // hard safety cap to prevent runaway loops
  while (page <= 200) {
    const { items, meta } = await listApplications(apiKey, jobId, {
      page,
      perPage,
    });
    if (!items || items.length === 0) break;
    all.push(...items);
    const totalPages =
      meta?.total_pages ?? meta?.last_page ?? meta?.pages ?? null;
    if (totalPages && page >= totalPages) break;
    if (items.length < perPage) break;
    page += 1;
  }
  return all;
}

export async function archiveApplication(apiKey, applicationId) {
  return request(apiKey, `/job_applications/${applicationId}/archive`, {
    method: "POST",
  });
}
