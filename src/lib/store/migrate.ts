// One-way import of the v1 single-page store (`.data/store.json`) into the v2 model.
// The v1 file is only read, never modified or deleted.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { countBySeverity, sortFindings } from "../audit/analyze";
import { checkInfo } from "../audit/catalog";
import { fingerprintOf } from "../audit/fingerprint";
import { LEGACY_V1_CHECKS, LEGACY_V1_NOTE } from "../audit/legacy";
import { prioritize } from "../audit/priority";
import { DEFAULT_RULE_CONFIG, type AuditFinding, type Facts, type RuleCategory, type RuleResult } from "../audit/types";
import { normalizePageUrl, originOf } from "../crawl/url";
import type { AuditRun, PageSnapshot } from "../model";
import { emptyStore, type AuditBlob, type StoreData } from "./store";

interface V1Finding {
  ruleCode: string;
  ruleId: string;
  pageUrl: string;
  severity: "high" | "medium" | "low";
  title: string;
  message: string;
  observed: string;
  expected: string;
  evidence: { snippets: string[]; facts: Facts };
  recommendations: string[];
  acceptanceCriteria: { id: string; description: string; params: Record<string, string | number> }[];
}
interface V1Audit {
  id: string;
  source: "live" | "sample";
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number;
  redirectChain: { url: string; status: number }[];
  fetchedAt: string;
  bytes: number;
  truncated: boolean;
  expectations: { canonicalUrl?: string; indexability?: "index" | "noindex" };
  rules: { ruleId: string; name: string; status: string; findings: V1Finding[]; facts: Facts; snippets: string[]; missingExpectations: string[] }[];
}

const CATEGORY: Record<string, RuleCategory> = { title: "metadata", canonical: "indexability", indexability: "indexability" };

export function migrateV1(v1: { audits?: Record<string, V1Audit>; expectations?: Record<string, { canonicalUrl?: string; indexability?: "index" | "noindex" }> }): {
  state: StoreData;
  blobs: Record<string, AuditBlob>;
} {
  const state = emptyStore();
  const blobs: Record<string, AuditBlob> = {};
  const live = Object.values(v1.audits ?? {}).filter((a) => a.source === "live").sort((a, b) => a.fetchedAt.localeCompare(b.fetchedAt));
  const siteByOrigin = new Map<string, string>();
  let n = 0;
  const id = (p: string) => `${p}-legacy-${++n}`;

  for (const a of live) {
    const origin = originOf(a.finalUrl);
    if (!origin) continue;
    let siteId = siteByOrigin.get(origin);
    if (!siteId) {
      siteId = id("site");
      siteByOrigin.set(origin, siteId);
      state.sites[siteId] = { id: siteId, name: new URL(origin).hostname, origin, createdAt: a.fetchedAt, notes: "Imported from an earlier Site Sentry version." };
    }
    const url = normalizePageUrl(a.requestedUrl) ?? a.requestedUrl;
    const finalUrl = normalizePageUrl(a.finalUrl) ?? a.finalUrl;
    const rules: RuleResult[] = a.rules.map((r) => ({
      ruleId: r.ruleId,
      name: r.name,
      category: CATEGORY[r.ruleId] ?? "metadata",
      status: (["pass", "fail", "needs_config"].includes(r.status) ? r.status : "pass") as RuleResult["status"],
      facts: r.facts,
      snippets: r.snippets,
      missingExpectations: r.missingExpectations as RuleResult["missingExpectations"],
      findings: [],
      checked: LEGACY_V1_CHECKS[r.ruleId] ?? [],
    }));
    const findings: AuditFinding[] = [];
    for (const r of a.rules) {
      for (const f of r.findings) {
        const info = checkInfo(f.ruleCode);
        const finding = {
          ...f,
          category: CATEGORY[f.ruleId] ?? "metadata",
          kind: info?.kind ?? "warning",
          certainty: info?.certainty ?? "verified",
          why: info?.why ?? "",
          scope: { kind: "page" as const, url: f.pageUrl },
          verify: "page" as const,
          expectationKey: f.ruleCode === "canonical/expected-url" ? `canonical=${a.expectations.canonicalUrl}` : undefined,
        };
        findings.push({ ...finding, fingerprint: fingerprintOf(finding), auditId: a.id, priority: prioritize(finding, { severityOverrides: {}, importantUrls: new Set(), homepage: normalizePageUrl("/", origin) }) });
      }
    }
    const facts = Object.assign({}, ...a.rules.map((r) => r.facts)) as Record<string, unknown>;
    const snapshot: PageSnapshot = {
      auditId: a.id,
      url,
      finalUrl,
      depth: 0,
      via: "seed",
      fetchedAt: a.fetchedAt,
      outcome: "inspected",
      status: a.httpStatus,
      redirectChain: a.redirectChain,
      contentType: "text/html",
      bytes: a.bytes,
      truncated: a.truncated,
      elapsedMs: null,
      expectations: { ...a.expectations, important: false },
      rules,
      links: null,
      summary: {
        title: typeof facts.titleText === "string" ? facts.titleText : null,
        description: null,
        h1: null,
        wordCount: null,
        noindex: facts.metaNoindex === true || facts.headerNoindex === true,
        canonical: typeof facts.canonicalResolved === "string" ? facts.canonicalResolved : null,
        canonicalSelf: null,
      },
    };
    const sorted = sortFindings(findings);
    const run: AuditRun = {
      id: a.id,
      siteId,
      source: "live",
      createdAt: a.fetchedAt,
      startedAt: a.fetchedAt,
      finishedAt: a.fetchedAt,
      heartbeatAt: a.fetchedAt,
      leaseUntil: null,
      cancelRequested: false,
      linkQueueBuilt: true,
      status: "completed",
      phase: "done",
      config: { mode: "single", urls: [url], maxPages: 1, maxDepth: 0, categories: ["metadata", "indexability"] satisfies RuleCategory[], checkLinks: false, includeImportant: false },
      queue: [],
      seen: [url],
      linkQueue: [],
      linkChecks: {},
      robots: null,
      sitemap: null,
      progress: { planned: 1, done: 1, inspected: 1, failed: 0, skipped: 0, linksChecked: 0 },
      coverage: [{ code: "graph_incomplete", message: LEGACY_V1_NOTE }],
      findingCounts: countBySeverity(sorted),
      ruleConfig: DEFAULT_RULE_CONFIG,
    };
    state.audits[run.id] = run;
    blobs[run.id] = { snapshots: [snapshot], findings: sorted };
  }

  for (const [pageUrl, exp] of Object.entries(v1.expectations ?? {})) {
    const origin = originOf(pageUrl);
    const siteId = origin ? siteByOrigin.get(origin) : undefined;
    if (!siteId || (!exp.canonicalUrl && !exp.indexability)) continue;
    const pid = id("page");
    state.pages[pid] = {
      id: pid,
      siteId,
      url: normalizePageUrl(pageUrl) ?? pageUrl,
      pageType: "other",
      labels: ["imported"],
      ...(exp.indexability ? { indexability: exp.indexability } : {}),
      ...(exp.canonicalUrl ? { canonicalUrl: exp.canonicalUrl } : {}),
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    };
  }
  return { state, blobs };
}

/** Called when the live workspace has no v2 state yet: import `<dataDir>/store.json` (v1) if present. */
export async function migrateLegacyFile(dataDir: string) {
  try {
    const v1 = JSON.parse(await readFile(path.join(dataDir, "store.json"), "utf8"));
    if (!v1 || typeof v1 !== "object" || !("audits" in v1)) return null;
    return migrateV1(v1);
  } catch {
    return null;
  }
}
