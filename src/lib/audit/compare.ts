// Coverage-aware audit comparison. Pure.
import type { AuditRun, PageSnapshot } from "../model";
import { LEGACY_V1_CHECKS, LEGACY_V1_NOTE } from "./legacy";
import { ruleById } from "./run";
import type { AuditFinding } from "./types";

export interface AuditCoverage {
  categories: Set<string>;
  /** URL (requested or final) → snapshot, for pages whose rules ran on a complete document. */
  inspected: Map<string, PageSnapshot>;
  /** URL → HTTP status, for every URL whose response is known (pages and link checks). */
  responded: Map<string, number>;
  robots: boolean;
  sitemap: boolean;
  graph: boolean;
  ruleConfig: AuditRun["ruleConfig"];
  /** Imported from v1, whose snapshots predate per-check records. */
  legacy: boolean;
}

export function coverageOf(audit: Pick<AuditRun, "config" | "robots" | "sitemap" | "linkChecks" | "coverage" | "ruleConfig" | "status">, pages: PageSnapshot[]): AuditCoverage {
  const inspected = new Map<string, PageSnapshot>();
  const responded = new Map<string, number>();
  for (const c of Object.values(audit.linkChecks)) if (c.status !== null) responded.set(c.url, c.status);
  for (const p of pages) {
    if (p.status !== null) {
      responded.set(p.url, p.status);
      if (!p.redirectChain.length) responded.set(p.finalUrl, p.status);
    }
    if (p.outcome === "inspected" && !p.truncated) {
      inspected.set(p.finalUrl, p);
      inspected.set(p.url, p);
    }
  }
  return {
    categories: new Set(audit.config.categories),
    inspected,
    responded,
    robots: audit.robots !== null && audit.robots.outcome !== "error",
    sitemap: audit.sitemap !== null && audit.sitemap.status !== null && audit.sitemap.status < 300,
    graph: audit.config.maxDepth > 0 && !audit.coverage.some((c) => c.code === "graph_incomplete" || c.code === "page_limit" || c.code === "cancelled"),
    ruleConfig: audit.ruleConfig,
    legacy: audit.coverage.some((c) => c.message === LEGACY_V1_NOTE),
  };
}

/**
 * Did this snapshot's rule evaluate this particular check? A rule that "passed" in an older audit
 * says nothing about checks added since, so absence there is not evidence the problem was absent.
 */
function ranCheck(result: { ruleId: string; checked?: string[] }, code: string, legacy: boolean): boolean {
  const checked = result.checked ?? (legacy ? (LEGACY_V1_CHECKS[result.ruleId] ?? []) : null);
  return checked === null || checked.includes(code);
}

/**
 * Did this audit actually re-examine everything the finding depends on? Only then can its absence
 * mean "resolved". A missing finding on an uninspected page is "not re-checked", never "fixed".
 */
export function isCovered(f: AuditFinding, cov: AuditCoverage): { covered: boolean; why: string } {
  if (!cov.categories.has(f.category)) return { covered: false, why: `The ${f.category} checks were not selected.` };
  if (f.ruleId === "robots") return cov.robots ? { covered: true, why: "" } : { covered: false, why: "robots.txt was not retrieved." };
  if (f.ruleId === "sitemap") return cov.sitemap ? { covered: true, why: "" } : { covered: false, why: "The sitemap was not retrieved." };

  switch (f.scope.kind) {
    case "page": {
      const url = f.scope.url;
      if (f.ruleId === "http") return cov.responded.has(url) ? { covered: true, why: "" } : { covered: false, why: `${url} was not requested.` };
      const snap = cov.inspected.get(url);
      if (!snap) return { covered: false, why: `${url} was not successfully inspected.` };
      const rule = ruleById(f.ruleId);
      const check = rule?.checks.find((c) => c.code === f.ruleCode);
      const result = snap.rules.find((r) => r.ruleId === f.ruleId);
      if (!rule || !check || !result || result.status === "skipped") return { covered: false, why: `The ${f.ruleId} rule did not run on ${url}.` };
      if ((check.needs ?? []).some((k) => snap.expectations[k] === undefined)) {
        return { covered: false, why: `The expectation this check needs is no longer configured for ${url}.` };
      }
      if (check.enabled && !check.enabled(cov.ruleConfig)) return { covered: false, why: "This check is switched off in settings." };
      if (!ranCheck(result, f.ruleCode, cov.legacy)) return { covered: false, why: "This check did not run in that audit (it was added later or not applicable then)." };
      return { covered: true, why: "" };
    }
    case "pages": {
      const missing = f.scope.urls.filter((u) => !cov.inspected.has(u));
      return missing.length ? { covered: false, why: `${missing.length} of the affected pages were not inspected.` } : { covered: true, why: "" };
    }
    case "target": {
      if (cov.responded.has(f.scope.url)) return { covered: true, why: "" };
      const allSources = f.scope.sources.every((s) => cov.inspected.has(s));
      return allSources ? { covered: true, why: "" } : { covered: false, why: `${f.scope.url} was not checked and not every linking page was re-crawled.` };
    }
    case "site":
      if (f.scope.check === "graph") return cov.graph ? { covered: true, why: "" } : { covered: false, why: "The link graph was not fully crawled." };
      return { covered: false, why: "" };
  }
}

export type ChangeKind = "regression" | "new" | "changed" | "persistent" | "resolved" | "not_rechecked";

export interface ComparisonEntry {
  fingerprint: string;
  kind: ChangeKind;
  base: AuditFinding | null;
  head: AuditFinding | null;
  note: string;
}

export interface Comparison {
  entries: ComparisonEntry[];
  counts: Record<ChangeKind, number>;
  /** Pages inspected in the base audit but not in the head audit. */
  lostCoverage: string[];
  /** Pages inspected in the head audit but not in the base audit. */
  newCoverage: string[];
}

const ORDER: ChangeKind[] = ["regression", "new", "changed", "persistent", "resolved", "not_rechecked"];

export function compareAudits(
  base: { audit: Parameters<typeof coverageOf>[0]; pages: PageSnapshot[]; findings: AuditFinding[] },
  head: { audit: Parameters<typeof coverageOf>[0]; pages: PageSnapshot[]; findings: AuditFinding[] },
): Comparison {
  const baseCov = coverageOf(base.audit, base.pages);
  const headCov = coverageOf(head.audit, head.pages);
  const baseBy = new Map(base.findings.map((f) => [f.fingerprint, f]));
  const headBy = new Map(head.findings.map((f) => [f.fingerprint, f]));
  const entries: ComparisonEntry[] = [];

  for (const h of head.findings) {
    const b = baseBy.get(h.fingerprint);
    if (b) {
      const changed = b.observed !== h.observed;
      entries.push({
        fingerprint: h.fingerprint,
        kind: changed ? "changed" : "persistent",
        base: b,
        head: h,
        note: changed ? `Observed value changed: ${b.observed} → ${h.observed}` : "Still present with the same observed value.",
      });
    } else {
      // Regression = the earlier audit examined this exact scope and did not find the problem.
      const prev = isCovered(h, baseCov);
      entries.push({
        fingerprint: h.fingerprint,
        kind: prev.covered ? "regression" : "new",
        base: null,
        head: h,
        note: prev.covered ? "Not present in the previous audit, which checked the same scope." : `First detection (${prev.why || "not checked before"}).`,
      });
    }
  }
  for (const b of base.findings) {
    if (headBy.has(b.fingerprint)) continue;
    const cov = isCovered(b, headCov);
    entries.push({
      fingerprint: b.fingerprint,
      kind: cov.covered ? "resolved" : "not_rechecked",
      base: b,
      head: null,
      note: cov.covered ? "Re-checked and no longer detected." : `Could not be re-checked: ${cov.why}`,
    });
  }
  entries.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || (a.head ?? a.base)!.priority.level - (b.head ?? b.base)!.priority.level);

  const counts = Object.fromEntries(ORDER.map((k) => [k, 0])) as Record<ChangeKind, number>;
  for (const e of entries) counts[e.kind]++;
  const baseInspected = new Set(base.pages.filter((p) => p.outcome === "inspected").map((p) => p.finalUrl));
  const headInspected = new Set(head.pages.filter((p) => p.outcome === "inspected").map((p) => p.finalUrl));
  return {
    entries,
    counts,
    lostCoverage: [...baseInspected].filter((u) => !headInspected.has(u)).sort(),
    newCoverage: [...headInspected].filter((u) => !baseInspected.has(u)).sort(),
  };
}
