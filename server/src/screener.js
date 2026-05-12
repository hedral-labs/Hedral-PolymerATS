import Anthropic from "@anthropic-ai/sdk";
import crypto from "node:crypto";

export function hashPrompt(prompt) {
  return crypto
    .createHash("sha256")
    .update(String(prompt || "").trim())
    .digest("hex")
    .slice(0, 16);
}

// The user-editable, natural-language part. Describes WHO to keep/archive
// and any judgment rules. No mention of the JSON output format — that lives
// in OUTPUT_SCHEMA_SUFFIX below and is appended automatically.
export const DEFAULT_CRITERIA = `You are an experienced technical recruiter screening applicants for an AEC (Architecture / Engineering / Construction) software company.

Your job is to evaluate each candidate's background and decide whether to KEEP them in the pipeline or ARCHIVE them.

ARCHIVE candidates who show ANY of the following:
1. India-based remote work — working remotely from India for foreign companies.
2. Contracting / freelancing as the primary career pattern (Upwork, Toptal, Fiverr, one-off clients, generic "freelance developer" history).
3. No recognizable employer history — only unknown companies with no startup pedigree, no established firm context, no real product work.
4. IT body shops / staffing agencies — Infosys, Wipro, TCS, Cognizant, HCL, Tech Mahindra, Capgemini India, Mindtree, L&T Infotech, etc.

KEEP candidates who show:
- Well-known tech companies, VC-backed startups, or established product companies.
- AEC industry firms (Autodesk, Trimble, Bentley, Procore, PlanGrid, structural/MEP/architecture firms, etc.).
- Solid career progression at real, recognizable organizations.

Rules:
- If a candidate has BOTH a body-shop background AND legitimate product company experience, weigh the most recent and longest tenure most heavily.
- If you are unsure or evidence is weak, default to KEEP with low confidence and flag it for manual review.
- Be conservative — when in doubt, KEEP.`;

// Fixed: never shown in the UI, never user-editable, never part of the
// promptHash. Appended at send-time.
const OUTPUT_SCHEMA_SUFFIX = `Output strictly a JSON object — no prose, no markdown fences:
{
  "decision": "KEEP" | "ARCHIVE",
  "confidence": "high" | "medium" | "low",
  "score": 0-100,
  "reason": "one sentence explaining the call",
  "flags": ["short", "tags", "for", "concerns"]
}

"score" is your numeric confidence in the decision: 100 = certain, 50 = very unsure, 0 = no signal. "confidence" must agree with "score": high ≥ 75, medium 40-74, low < 40.`;

// Defensive: if a user pasted the JSON-output spec into their criteria (or
// loaded an older saved prompt that had it), strip it before display/storage.
export function stripOutputSpec(text) {
  if (!text) return "";
  const m = text.match(/\n\s*Output strictly a JSON object/i);
  return (m ? text.slice(0, m.index) : text).trim();
}

export function buildSystemPrompt(criteria) {
  const clean = stripOutputSpec(criteria || DEFAULT_CRITERIA);
  return `${clean}\n\n${OUTPUT_SCHEMA_SUFFIX}`;
}

// Backwards-compat alias — some imports still use DEFAULT_PROMPT.
export const DEFAULT_PROMPT = DEFAULT_CRITERIA;

function pickResumeUrl(app) {
  const fromFiles =
    Array.isArray(app?.files) &&
    (app.files.find?.((a) => /resume|cv/i.test(a?.name || a?.filename || ""))?.url ||
      app.files[0]?.url);
  return (
    app?.resume_url ||
    app?.resumeUrl ||
    app?.candidate_resume_url ||
    app?.resume?.url ||
    fromFiles ||
    null
  );
}

function pickLinkedIn(app) {
  const direct =
    app?.candidate_linkedin_url ||
    app?.linkedin_url ||
    app?.linkedinUrl ||
    null;
  if (direct) return direct;
  const answers = app?.question_responses || app?.answers || [];
  for (const a of answers) {
    const val = a?.answer || a?.response || a?.value || "";
    if (typeof val === "string" && /linkedin\.com/i.test(val)) return val.trim();
  }
  return null;
}

function pickQuestions(app) {
  const answers = app?.answers || app?.question_responses || [];
  return answers
    .map((a) => {
      const q = a?.question || a?.question_text || a?.label || "Question";
      const v = a?.answer || a?.response || a?.value || "";
      return v ? `Q: ${q}\nA: ${v}` : null;
    })
    .filter(Boolean);
}

function pickFrom(...candidates) {
  for (const v of candidates) {
    if (v != null && String(v).trim() !== "") return v;
  }
  return null;
}

// Stages where the candidate is already out of the pipeline — no point
// re-screening (and Polymer often anonymizes these).
export function isArchivedStage(stageName) {
  if (!stageName) return false;
  const lower = String(stageName).toLowerCase().trim();
  const exact = new Set([
    "archived",
    "archive",
    "rejected",
    "disqualified",
    "withdrawn",
    "declined",
    "not a fit",
    "hired", // also already-out-of-pipeline
  ]);
  if (exact.has(lower)) return true;
  // Patterns like "Rejected - too senior", "Archived (auto)"
  return /^(rejected|archived|disqualif|withdrawn|declined)\b/.test(lower);
}

// Polymer anonymizes archived candidates — no name and no email remain.
export function isAnonymizedApplication(app) {
  const first = String(app?.candidate_first_name || "").trim();
  const last = String(app?.candidate_last_name || "").trim();
  const email = String(app?.candidate_email || "").trim();
  return !first && !last && !email;
}

// Returns { skip, reason } if the application should not be screened.
export function shouldSkipApplication(app) {
  const stage =
    app?.hiring_stage_name ||
    (typeof app?.current_hiring_stage === "string"
      ? app.current_hiring_stage
      : app?.current_hiring_stage?.name) ||
    null;
  if (isArchivedStage(stage)) {
    return { skip: true, reason: `stage="${stage}"` };
  }
  if (isAnonymizedApplication(app)) {
    return { skip: true, reason: "anonymized (no name/email)" };
  }
  return { skip: false };
}

export function normalizeApplicant(app) {
  // Polymer's hire API returns applications as a flat object with
  // candidate_* prefixed fields. We also handle a nested `applicant` shape
  // defensively in case different accounts return different schemas.
  const a = app || {};
  const nested = (a && typeof a.applicant === "object" && a.applicant) || {};

  const first = pickFrom(a.candidate_first_name, a.first_name, nested.first_name, nested.firstName);
  const last = pickFrom(a.candidate_last_name, a.last_name, nested.last_name, nested.lastName);
  const fullFromParts = [first, last].filter(Boolean).join(" ").trim();
  const name =
    pickFrom(
      a.candidate_name,
      a.name,
      nested.name,
      nested.full_name,
      fullFromParts,
      a.candidate_email,
      a.email,
      nested.email
    ) || "Unknown";

  const email = pickFrom(a.candidate_email, a.email, nested.email);
  const location = pickFrom(
    a.candidate_location,
    a.location,
    nested.location,
    nested.city,
    [nested.city, nested.country].filter(Boolean).join(", ")
  );

  return {
    id: String(pickFrom(a.id, a.application_id, a.hash_id, nested.id) ?? ""),
    hashId: pickFrom(a.hash_id) || null,
    name,
    email,
    location,
    linkedinUrl: pickLinkedIn(app),
    resumeUrl: pickResumeUrl(app),
    appliedAt: pickFrom(a.applied_at, a.created_at, a.createdAt),
    jobId: String(pickFrom(a.job_id, a.job?.id, a.jobId) ?? ""),
    jobHashId: pickFrom(a.job_hash_id) || null,
    status: pickFrom(
      a.hiring_stage_name,
      typeof a.current_hiring_stage === "string" ? a.current_hiring_stage : a.current_hiring_stage?.name,
      a.status,
      a.state
    ),
    questions: pickQuestions(app),
    raw: app,
  };
}

function buildUserMessage(candidate, { hasResumePdf } = {}) {
  const lines = [
    `Name: ${candidate.name}`,
    candidate.location ? `Location: ${candidate.location}` : null,
    candidate.linkedinUrl ? `LinkedIn: ${candidate.linkedinUrl}` : null,
    candidate.email ? `Email: ${candidate.email}` : null,
    hasResumePdf
      ? "Resume: attached above as PDF — read it carefully for employer history."
      : candidate.resumeUrl
      ? `Resume: ${candidate.resumeUrl} (URL only — content not fetched)`
      : null,
  ].filter(Boolean);

  if (candidate.questions && candidate.questions.length) {
    lines.push("\nApplication responses:");
    lines.push(candidate.questions.join("\n\n"));
  }

  return `Evaluate this candidate and return ONLY the JSON object described in the system prompt.\n\n${lines.join("\n")}`;
}

const MAX_RESUME_BYTES = 8 * 1024 * 1024; // 8 MB

export async function fetchResumeDocument(url) {
  if (!url) return null;
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) {
      console.warn(`[resume] HTTP ${res.status} for ${url.slice(0, 80)}`);
      return null;
    }
    const contentType = (res.headers.get("content-type") || "").toLowerCase();
    const isPdf =
      contentType.includes("application/pdf") ||
      /\.pdf(\?|$)/i.test(url);
    if (!isPdf) {
      console.warn(`[resume] not a PDF (content-type=${contentType || "?"}); skipping ${url.slice(0, 80)}`);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_RESUME_BYTES) {
      console.warn(`[resume] too large (${buf.length} bytes); skipping`);
      return null;
    }
    return {
      type: "document",
      source: {
        type: "base64",
        media_type: "application/pdf",
        data: buf.toString("base64"),
      },
    };
  } catch (err) {
    console.warn(`[resume] fetch error: ${err.message}`);
    return null;
  }
}

function parseDecision(text) {
  if (!text) return null;
  let body = text.trim();
  // strip markdown fences if present
  body = body.replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  // pull the first {...} blob
  const match = body.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const parsed = JSON.parse(match[0]);
    const decision =
      String(parsed.decision || "").toUpperCase() === "ARCHIVE"
        ? "ARCHIVE"
        : "KEEP";
    const rawScore = Number(parsed.score);
    const score = Number.isFinite(rawScore)
      ? Math.max(0, Math.min(100, Math.round(rawScore)))
      : null;
    let confidence = ["high", "medium", "low"].includes(
      String(parsed.confidence || "").toLowerCase()
    )
      ? String(parsed.confidence).toLowerCase()
      : null;
    // Derive confidence from score if missing or inconsistent.
    if (!confidence && score != null) {
      confidence = score >= 75 ? "high" : score >= 40 ? "medium" : "low";
    }
    if (!confidence) confidence = "low";
    return {
      decision,
      confidence,
      score,
      reason: String(parsed.reason || "").trim() || "No reason provided.",
      flags: Array.isArray(parsed.flags) ? parsed.flags.map(String) : [],
    };
  } catch {
    return null;
  }
}

export async function screenCandidate({
  candidate,
  apiKey,
  model = "claude-sonnet-4-20250514",
  criteria = DEFAULT_CRITERIA,
}) {
  if (!apiKey) throw new Error("Anthropic API key not configured");
  const client = new Anthropic({ apiKey });

  // Documents must come BEFORE the text question per Anthropic's guidance.
  const resumeDoc = await fetchResumeDocument(candidate.resumeUrl);
  const userText = buildUserMessage(candidate, { hasResumePdf: !!resumeDoc });
  const content = [];
  if (resumeDoc) content.push(resumeDoc);
  content.push({ type: "text", text: userText });

  const response = await client.messages.create({
    model,
    max_tokens: 800,
    system: buildSystemPrompt(criteria),
    messages: [{ role: "user", content }],
  });
  const text = response.content
    ?.map((c) => (c.type === "text" ? c.text : ""))
    .join("")
    .trim();

  const parsed = parseDecision(text);
  const meta = { model, userText, hasResumePdf: !!resumeDoc };
  if (!parsed) {
    return {
      ...meta,
      decision: "KEEP",
      confidence: "low",
      score: null,
      reason: "Screener returned unparseable output; defaulted to KEEP.",
      flags: ["parse_error"],
      raw: text,
    };
  }
  // Per spec: low-confidence ARCHIVE decisions default to KEEP for manual review.
  if (parsed.decision === "ARCHIVE" && parsed.confidence === "low") {
    return {
      ...meta,
      ...parsed,
      decision: "KEEP",
      flags: [...parsed.flags, "low_confidence_archive_downgraded"],
    };
  }
  return { ...meta, ...parsed };
}
