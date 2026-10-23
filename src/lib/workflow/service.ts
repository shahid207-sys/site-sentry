import { randomUUID } from "node:crypto";
import { normaliseUrl } from "../audit/rules/canonical";
import { runRules } from "../audit/run";
import type { AuditResult, PageExpectations, TrackedFinding, VerificationAttempt } from "../audit/types";
import { SafeFetchError } from "../fetch/safe-fetch";
import type { SampleState } from "../sample/sample-page";
import type { Store } from "../store/store";
import { fetchLivePage, fetchSamplePage, type FetchedPage, type LiveFetcher } from "./pages";
import { applyAttempt, evaluateAttempt, inconclusiveFromError } from "./verify";

export interface Deps {
  store: Store;
  fetchLive: LiveFetcher;
  now: () => Date;
  newId: () => string;
}

export const defaultDeps = (store: Store): Deps => ({
  store,
  fetchLive: fetchLivePage,
  now: () => new Date(),
  newId: () => randomUUID(),
});

export class WorkflowError extends Error {
  constructor(
    public code: "NOT_FOUND" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

const key = (url: string) => normaliseUrl(url) ?? url;

function lookupExpectations(all: Record<string, PageExpectations>, ...urls: string[]): PageExpectations {
  for (const u of urls) if (all[key(u)]) return all[key(u)];
  return {};
}

// ---------- audits ----------

/** Live audit of a URL, or the sample audit (which always starts from the original broken sample page). */
export async function runAudit(input: { url: string } | { sample: true }, deps: Deps): Promise<AuditResult> {
  let page: FetchedPage;
  if ("sample" in input) {
    await deps.store.update((d) => void (d.sampleState = "broken"));
    page = fetchSamplePage("broken");
  } else {
    page = await deps.fetchLive(input.url); // throws SafeFetchError
  }

  const { expectations: all } = await deps.store.read();
  const expectations = lookupExpectations(all, page.finalUrl, page.requestedUrl);
  const audit: AuditResult = {
    id: deps.newId(),
    source: page.source,
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    httpStatus: page.status,
    redirectChain: page.redirectChain,
    fetchedAt: deps.now().toISOString(),
    bytes: page.bytes,
    truncated: page.truncated,
    expectations,
    rules: runRules({ html: page.html, pageUrl: page.finalUrl, headers: page.headers }, expectations),
  };
  await deps.store.update((d) => void (d.audits[audit.id] = audit));
  return audit;
}

// ---------- expectations ----------

export function validateExpectations(input: unknown): PageExpectations {
  const raw = (input ?? {}) as Record<string, unknown>;
  const out: PageExpectations = {};
  if (raw.canonicalUrl !== undefined && raw.canonicalUrl !== "") {
    const url = typeof raw.canonicalUrl === "string" ? normaliseUrl(raw.canonicalUrl) : null;
    if (!url || !/^https?:/.test(url)) throw new WorkflowError("INVALID", "Expected canonical must be an absolute http(s) URL.");
    out.canonicalUrl = url;
  }
  if (raw.indexability !== undefined && raw.indexability !== "") {
    if (raw.indexability !== "index" && raw.indexability !== "noindex") {
      throw new WorkflowError("INVALID", 'Intended indexability must be "index" or "noindex".');
    }
    out.indexability = raw.indexability;
  }
  return out;
}

export async function setExpectations(pageUrl: string, input: unknown, deps: Deps): Promise<PageExpectations> {
  const exp = validateExpectations(input);
  await deps.store.update((d) => {
    d.expectations[key(pageUrl)] = exp;
  });
  return exp;
}

// ---------- tracked findings ----------

/** Track a finding from a stored audit. The client only names it; evidence comes from the server's own record. */
export async function trackFinding(auditId: string, ruleCode: string, deps: Deps): Promise<TrackedFinding> {
  return deps.store.update((d) => {
    const audit = d.audits[auditId];
    if (!audit) throw new WorkflowError("NOT_FOUND", "Audit not found. Run the audit again.");
    const rule = audit.rules.find((r) => r.findings.some((f) => f.ruleCode === ruleCode));
    const finding = rule?.findings.find((f) => f.ruleCode === ruleCode);
    if (!rule || !finding) throw new WorkflowError("NOT_FOUND", `No ${ruleCode} finding in this audit.`);

    const existing = Object.values(d.findings).find(
      (t) => t.status === "open" && t.source === audit.source && t.finding.pageUrl === finding.pageUrl && t.finding.ruleCode === ruleCode,
    );
    if (existing) return existing;

    const tracked: TrackedFinding = {
      id: deps.newId(),
      createdAt: deps.now().toISOString(),
      auditId,
      source: audit.source,
      status: "open",
      resolvedAt: null,
      finding,
      originalObservation: {
        capturedAt: audit.fetchedAt,
        source: audit.source,
        finalUrl: audit.finalUrl,
        httpStatus: audit.httpStatus,
        facts: rule.facts,
        snippets: rule.snippets,
      },
      expectations: audit.expectations,
      attempts: [],
    };
    d.findings[tracked.id] = tracked;
    return tracked;
  });
}

export async function listFindings(deps: Deps): Promise<TrackedFinding[]> {
  const { findings } = await deps.store.read();
  return Object.values(findings).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Re-scan the finding's page and judge it against the original acceptance criteria.
 * The fetcher is chosen from the stored finding's source; the client cannot supply evidence.
 * Every call records exactly one attempt.
 */
export async function verifyFinding(id: string, deps: Deps): Promise<TrackedFinding> {
  // Read and fetch outside the lock: fetches can take up to 10s.
  const snapshot = await deps.store.read();
  const tracked = snapshot.findings[id];
  if (!tracked) throw new WorkflowError("NOT_FOUND", "Tracked finding not found.");

  const at = deps.now().toISOString();
  let body: Omit<VerificationAttempt, "id" | "at">;
  try {
    const page =
      tracked.source === "sample"
        ? fetchSamplePage(snapshot.sampleState)
        : await deps.fetchLive(tracked.finding.pageUrl);
    body = evaluateAttempt(tracked, page, at);
  } catch (e) {
    body = inconclusiveFromError(
      e instanceof SafeFetchError
        ? { code: e.code, message: e.message }
        : { code: "INTERNAL", message: (e as Error)?.message ?? "Unexpected error" },
    );
  }
  const attempt: VerificationAttempt = { id: deps.newId(), at, ...body };

  return deps.store.update((d) => {
    const current = d.findings[id];
    if (!current) throw new WorkflowError("NOT_FOUND", "Tracked finding not found.");
    d.findings[id] = applyAttempt(current, attempt);
    return d.findings[id];
  });
}

export async function setSampleState(state: unknown, deps: Deps): Promise<SampleState> {
  if (state !== "broken" && state !== "fixed" && state !== "offline") {
    throw new WorkflowError("INVALID", 'Sample state must be "broken", "fixed" or "offline".');
  }
  await deps.store.update((d) => void (d.sampleState = state));
  return state;
}
