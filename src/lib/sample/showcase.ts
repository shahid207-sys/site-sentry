// The public sample audit and the homepage preview card: Northwind Outdoor from the bundled sample
// workspace, read through the same issue logic as the workspace itself. Deterministic, no network.
import "server-only";
import { cacheLife } from "next/cache";
import { compareAudits } from "../audit/compare";
import { groupIssues } from "../audit/groups";
import { countIssueTypes, healthBand, healthScore, type HealthBand } from "../audit/health";
import { finishedAudits } from "../audit/issues";
import type { Certainty, FindingKind, RuleCategory, Severity } from "../audit/types";
import { siteIssues } from "../server/queries";
import { MemoryStore } from "../store/store";
import type { SeverityCounts } from "../views";
import { buildSampleSeed } from "./seed";

const SITE_ID = "smp-site-nw";

export interface ShowcaseIssue {
  ruleCode: string;
  title: string;
  category: RuleCategory;
  kind: FindingKind;
  certainty: Certainty;
  severity: Severity;
  priority: number;
  pages: string[];
  why: string;
  observed: string;
  expected: string;
  snippet: string | null;
  recommendations: string[];
  criteria: string[];
}

export interface ShowcasePage {
  url: string;
  status: number | null;
  outcome: string;
  title: string | null;
  wordCount: number | null;
  openIssues: number;
}

export interface SampleShowcase {
  auditId: string;
  siteName: string;
  origin: string;
  auditedAt: string;
  pagesInspected: number;
  health: number;
  band: HealthBand;
  /** Open issue types by worst severity (the health score's unit). */
  openTypes: SeverityCounts;
  /** Open issue instances by severity. */
  instances: SeverityCounts;
  /** Distinct checks the latest audit ran that found nothing open. */
  passedChecks: number;
  issues: ShowcaseIssue[];
  pages: ShowcasePage[];
  /** One point per finished audit, oldest first: the health of what that audit found. */
  history: { at: string; health: number }[];
  sinceLast: { resolved: number; regression: number } | null;
}

export async function getSampleShowcase(): Promise<SampleShowcase> {
  "use cache";
  cacheLife("max");
  const seed = await buildSampleSeed();
  const store = new MemoryStore(seed.state, { blobs: seed.blobs });
  const data = await store.read();
  const site = data.sites[SITE_ID];
  if (!site) throw new Error("Sample seed has no Northwind Outdoor site");
  const { bundles, issues } = await siteIssues(store, data, SITE_ID);
  const done = finishedAudits(bundles);
  const head = done.at(-1);
  if (!head) throw new Error("Sample seed has no finished Northwind audit");

  const open = issues.filter((i) => i.state === "open");
  const findings = open.map((i) => i.latest);
  const openTypes = countIssueTypes(findings);
  const health = healthScore(openTypes);
  const instances: SeverityCounts = { high: 0, medium: 0, low: 0 };
  for (const f of findings) instances[f.priority.severity]++;

  const ran = new Set(head.pages.flatMap((p) => p.rules.flatMap((r) => r.checked ?? [])));
  const failing = new Set(findings.map((f) => f.ruleCode));
  const passedChecks = [...ran].filter((c) => !failing.has(c)).length;

  const byFp = new Map(open.map((i) => [i.fingerprint, i.latest]));
  const groups = groupIssues(open.map((i) => ({ fingerprint: i.fingerprint, siteId: i.siteId, finding: i.latest })));
  const showcaseIssues: ShowcaseIssue[] = groups.map((g) => {
    const f = byFp.get(g.instances[0].fingerprint)!;
    return {
      ruleCode: g.ruleCode,
      title: g.title,
      category: g.category,
      kind: g.kind,
      certainty: g.certainty,
      severity: g.severity,
      priority: g.priority,
      pages: g.pages,
      why: f.why,
      observed: f.observed,
      expected: f.expected,
      snippet: f.evidence.snippets[0] ?? null,
      recommendations: f.recommendations,
      criteria: f.acceptanceCriteria.map((c) => c.description),
    };
  });

  const perPage = new Map<string, number>();
  for (const f of findings) perPage.set(f.pageUrl, (perPage.get(f.pageUrl) ?? 0) + 1);
  const pages: ShowcasePage[] = head.pages
    .map((p) => ({ url: p.url, status: p.status, outcome: p.outcome, title: p.summary.title, wordCount: p.summary.wordCount, openIssues: perPage.get(p.url) ?? 0 }))
    .sort((a, b) => b.openIssues - a.openIssues || a.url.localeCompare(b.url));

  const prev = done.at(-2);
  const c = prev ? compareAudits(prev, head) : null;
  const sinceLast = c ? { resolved: c.counts.resolved, regression: c.counts.regression } : null;

  return {
    auditId: head.audit.id,
    siteName: site.name,
    origin: site.origin,
    auditedAt: head.audit.finishedAt ?? head.audit.startedAt,
    pagesInspected: head.audit.progress.inspected,
    health,
    band: healthBand(health),
    openTypes,
    instances,
    passedChecks,
    issues: showcaseIssues,
    pages,
    history: done.map((b) => ({ at: b.audit.startedAt, health: healthScore(countIssueTypes(b.findings)) })),
    sinceLast,
  };
}
