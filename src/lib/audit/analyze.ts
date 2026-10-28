import type { LinkCheck, PageSnapshot, RobotsSnapshot, SitemapSnapshot } from "../model";
import { normalizePageUrl } from "../crawl/url";
import { fingerprintOf } from "./fingerprint";
import { prioritize } from "./priority";
import { SITE_RULES } from "./site";
import type { AuditFinding, Finding, PageExpectations, RuleCategory, RuleConfig, Severity } from "./types";

export interface AnalyzeInput {
  auditId: string;
  origin: string;
  pages: PageSnapshot[];
  linkChecks: Record<string, LinkCheck>;
  robots: RobotsSnapshot | null;
  sitemap: SitemapSnapshot | null;
  intents: Record<string, PageExpectations>;
  config: RuleConfig;
  categories: RuleCategory[];
  severityOverrides: Record<string, Severity>;
  graphComplete: boolean;
  maxDepth: number;
}

export function sortFindings(list: AuditFinding[]): AuditFinding[] {
  return [...list].sort(
    (a, b) =>
      a.priority.level - b.priority.level ||
      b.priority.score - a.priority.score ||
      a.ruleCode.localeCompare(b.ruleCode) ||
      a.pageUrl.localeCompare(b.pageUrl),
  );
}

/** Pure: snapshots in, prioritised fingerprinted findings out. */
export function analyzeAudit(input: AnalyzeInput): AuditFinding[] {
  const raw: Finding[] = [];
  for (const p of input.pages) for (const r of p.rules) raw.push(...r.findings);
  for (const rule of SITE_RULES) {
    if (!input.categories.includes(rule.category)) continue;
    raw.push(
      ...rule.analyze({
        origin: input.origin,
        pages: input.pages,
        linkChecks: input.linkChecks,
        robots: input.robots,
        sitemap: input.sitemap,
        intents: input.intents,
        config: input.config,
        graphComplete: input.graphComplete,
        maxDepth: input.maxDepth,
      }),
    );
  }

  // A 404 reached only by following a link is reported once, as a broken internal link.
  const brokenTargets = new Set(raw.filter((f) => f.ruleCode === "links/broken-internal").map((f) => f.pageUrl));
  const linkOnly = new Set(input.pages.filter((p) => p.via === "link").map((p) => p.url));
  const kept = raw.filter((f) => !(f.ruleCode === "http/error-status" && brokenTargets.has(f.pageUrl) && linkOnly.has(f.pageUrl)));

  const importantUrls = new Set(Object.keys(input.intents));
  const ctx = { severityOverrides: input.severityOverrides, importantUrls, homepage: normalizePageUrl("/", input.origin) };
  const seen = new Set<string>();
  const out: AuditFinding[] = [];
  for (const f of kept) {
    const fingerprint = fingerprintOf(f);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push({ ...f, fingerprint, auditId: input.auditId, priority: prioritize(f, ctx) });
  }
  return sortFindings(out);
}

export function countBySeverity(list: AuditFinding[]): Record<Severity, number> {
  const out: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const f of list) out[f.priority.severity]++;
  return out;
}
