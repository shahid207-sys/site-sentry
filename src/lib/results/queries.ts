// The read side of a v2 crawl's results: one module for the API and the report, so every number shown anywhere
// comes from the same query.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { IssueState } from "../db/schema";
import type { Priority } from "./priority";
import { ANSWERED, crawlComplete, crawlCoverage, type Coverage, coverageVerdict, type CoverageVerdict } from "./coverage";
import type { Health } from "./health";
import { OPEN_STATES, projectKey, rechecked, wideAudits, type StateCounts } from "./states";

type Exec = Pick<Db, "execute">;

export class ResultsError extends Error {
  constructor(
    public code: "NOT_FOUND" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

/**
 * SQL: an audit's issue states as shown everywhere (API, report): the audit's own state, except that a fingerprint a
 * later fix verification of this audit resolved (its latest verification result) shows as resolved. Columns:
 * fingerprint, rule_id, url, evidence_key, template_id, outcome, state, audit_state, verify_state, verified_by.
 */
export const effectiveStates = (auditCrawlId: string) => sql`(select s.fingerprint, s.rule_id, s.url, s.evidence_key, s.template_id, s.outcome,
    case when v.state = 'resolved' then 'resolved' else s.state end as state, s.state as audit_state, v.state as verify_state, v.crawl_id as verified_by
  from issue_states s left join (
    select distinct on (vs.fingerprint) vs.fingerprint, vs.state, vs.crawl_id from issue_states vs join crawls vc on vc.id = vs.crawl_id
    where vc.kind = 'verify' and vc.config->'verify'->>'auditCrawlId' = ${auditCrawlId}
    order by vs.fingerprint, vc.created_at desc, vc.id desc) v on v.fingerprint = s.fingerprint
  where s.crawl_id = ${auditCrawlId}::uuid)`;

export async function effectiveStateCounts(db: Exec, auditCrawlId: string): Promise<StateCounts> {
  const r = await db.execute(sql`select state, count(*)::int as n from ${effectiveStates(auditCrawlId)} e group by state`);
  const out: StateCounts = { new: 0, persistent: 0, resolved: 0, regressed: 0, not_rechecked: 0, inconclusive: 0 };
  for (const x of r.rows as { state: IssueState; n: number }[]) out[x.state] = x.n;
  return out;
}

export interface CrawlOverview {
  crawlId: string;
  workspace: string;
  project: string;
  siteOrigin: string;
  profile: string;
  /** URL budget and click depth the crawl ran with; null = unlimited. */
  budget: number | null;
  maxDepth: number | null;
  status: string;
  createdAt: string;
  analysed: boolean;
  coverage: Coverage;
  /** Complete or partial, and exactly why, from the crawl's URL states. */
  verdict: CoverageVerdict;
  health: Health | null;
  /** Issue states per state, verified fixes included (effectiveStates). */
  states: StateCounts;
  /** Fingerprints a fix verification resolved. */
  verifiedResolved: number;
  /** Issue groups with at least one affected URL, per priority. */
  priorities: Record<Priority, number>;
  issueGroups: number;
  /** Rules with rule_runs status 'ran'. */
  rulesRan: number;
}

export async function crawlOverview(db: Exec, crawlId: string): Promise<CrawlOverview> {
  const r = await db.execute(sql`select id, kind, workspace, ${projectKey("c")} as project, site_origin, profile, status, created_at, analysis->>'status' as analysis, budget, max_depth, robots, health
    from crawls c where id = ${crawlId}::uuid`);
  const c = r.rows[0] as { id: string; kind: string; workspace: string; project: string; site_origin: string; profile: string; status: string; created_at: Date | string; analysis: string | null; budget: number | null; max_depth: number | null; robots: { outcome?: string; reason?: string } | null; health: Health | null } | undefined;
  if (!c) throw new ResultsError("NOT_FOUND", "Crawl not found.");
  if (c.kind !== "audit") throw new ResultsError("INVALID", "This crawl is a fix verification, not an audit.");
  // Independent reads: run them together (the pool has room; this is the first request of the Overview screen).
  const [st, g, ran, coverage] = await Promise.all([
    // States and verified fixes in one pass over the effective states.
    db.execute(sql`select state, count(*)::int as n, count(*) filter (where verify_state = 'resolved')::int as verified from ${effectiveStates(crawlId)} e group by state`),
    db.execute(sql`select priority, count(*)::int as n from issue_groups where crawl_id = ${crawlId}::uuid and affected_urls > 0 group by priority`),
    db.execute(sql`select count(*)::int as n from rule_runs where crawl_id = ${crawlId}::uuid and status = 'ran'`),
    crawlCoverage(db, crawlId),
  ]);
  const states: StateCounts = { new: 0, persistent: 0, resolved: 0, regressed: 0, not_rechecked: 0, inconclusive: 0 };
  let verifiedResolved = 0;
  for (const x of st.rows as { state: IssueState; n: number; verified: number }[]) {
    states[x.state] = x.n;
    verifiedResolved += x.verified;
  }
  const priorities: Record<Priority, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const x of g.rows as { priority: Priority; n: number }[]) priorities[x.priority] = x.n;
  const verdict = coverageVerdict(coverage.states, { status: c.status, budget: c.budget, maxDepth: c.max_depth, robots: c.robots });
  return {
    crawlId: c.id,
    workspace: c.workspace,
    project: c.project,
    siteOrigin: c.site_origin,
    profile: c.profile,
    budget: c.budget,
    maxDepth: c.max_depth,
    status: c.status,
    createdAt: new Date(c.created_at).toISOString(),
    analysed: c.analysis === "completed",
    coverage,
    verdict,
    // The stored flag counts out-of-scope URLs as uncrawled. A complete audit must not also say it covered too little.
    health: c.health && verdict.verdict === "complete" ? { ...c.health, partialCoverage: false } : c.health,
    states,
    verifiedResolved,
    priorities,
    issueGroups: Object.values(priorities).reduce((a, b) => a + b, 0),
    rulesRan: (ran.rows[0] as { n: number }).n,
  };
}

export interface TemplateSplit {
  templateId: string;
  affectedUrls: number;
  sampleUrls: string[];
}

export interface IssueGroupRow {
  ruleId: string;
  category: string;
  impact: number;
  confidence: string;
  confidenceWeight: number;
  affectedPages: number;
  indexablePages: number;
  reach: number;
  score: number;
  priority: Priority;
  affectedUrls: number;
  inconclusiveUrls: number;
  templateCount: number;
  sampleUrls: string[];
  templates: TemplateSplit[];
  /** The group's fingerprints in this crawl per issue state. */
  states: Partial<Record<IssueState, number>>;
}

/** The crawl's issue groups with an affected URL, highest priority score first (rule id breaks ties). */
export async function issueGroups(db: Exec, crawlId: string, opts: { ruleIds?: string[] } = {}): Promise<IssueGroupRow[]> {
  const only = opts.ruleIds ? sql`and g.rule_id in (${sql.join(opts.ruleIds.length ? opts.ruleIds.map((x) => sql`${x}`) : [sql`null`], sql`, `)})` : sql``;
  const r = await db.execute(sql`select g.*,
      coalesce((select jsonb_agg(jsonb_build_object('templateId', t.template_id, 'affectedUrls', t.affected_urls, 'sampleUrls', t.sample_urls) order by t.affected_urls desc, t.template_id collate "C")
        from issue_group_templates t where t.crawl_id = g.crawl_id and t.rule_id = g.rule_id), '[]'::jsonb) as templates,
      coalesce(st.states, '{}'::jsonb) as states
    from issue_groups g
    -- Per-rule state counts in one pass over the effective states, not one pass per group.
    left join (select x.rule_id, jsonb_object_agg(x.state, x.n) as states
      from (select e.rule_id, e.state, count(*)::int as n from ${effectiveStates(crawlId)} e group by e.rule_id, e.state) x group by x.rule_id) st on st.rule_id = g.rule_id
    where g.crawl_id = ${crawlId}::uuid and g.affected_urls > 0 ${only}
    order by g.score desc, g.rule_id collate "C"`);
  return (r.rows as Record<string, unknown>[]).map((g) => ({
    ruleId: g.rule_id as string,
    category: g.category as string,
    impact: Number(g.impact),
    confidence: g.confidence as string,
    confidenceWeight: Number(g.confidence_weight),
    affectedPages: Number(g.affected_pages),
    indexablePages: Number(g.indexable_pages),
    reach: Number(g.reach),
    score: Number(g.score),
    priority: g.priority as Priority,
    affectedUrls: Number(g.affected_urls),
    inconclusiveUrls: Number(g.inconclusive_urls),
    templateCount: Number(g.template_count),
    sampleUrls: g.sample_urls as string[],
    templates: g.templates as TemplateSplit[],
    states: g.states as Partial<Record<IssueState, number>>,
  }));
}

/** How a group changed between two audits. */
export type GroupChange = "new" | "persistent" | "resolved" | "regressed" | "not_rechecked";
/** How a fingerprint changed: the group changes plus inconclusive (observed, but the check could not decide). */
export type FingerprintChange = GroupChange | "inconclusive";

export interface GroupComparison {
  ruleId: string;
  change: GroupChange;
  /** Fingerprints per change. */
  counts: Record<FingerprintChange, number>;
}

export interface Comparison {
  base: CrawlOverview;
  head: CrawlOverview;
  groups: GroupComparison[];
  /** Groups per change. */
  totals: Record<GroupChange, number>;
  scopeMismatch: boolean;
  warnings: string[];
}

/** Coverage (percentage points) the two audits may differ by before the comparison is flagged. */
export const SCOPE_TOLERANCE = 10;

/**
 * Compares two analysed crawls of one project, older → newer whatever the argument order. Per fingerprint:
 * open in the base audit and observed again as an issue → persistent (regressed when a fix verification between the
 * two resolved it); observed inconclusive → inconclusive; not observed → resolved when the newer audit re-checked it
 * (`rechecked`) or a fix verification between the two resolved it, else not_rechecked; an issue observed only in
 * the newer audit → regressed when the project saw it before the base audit (it was resolved by then), else new.
 * A group is persistent when any fingerprint persists; else regressed / new when it has one; else resolved when
 * every base fingerprint resolved; else not_rechecked.
 */
export async function compareCrawls(db: Exec, a: string, b: string): Promise<Comparison> {
  const [x, y] = await Promise.all([crawlOverview(db, a), crawlOverview(db, b)]);
  if (x.workspace !== y.workspace || x.project !== y.project) throw new ResultsError("INVALID", "Both audits must belong to the same project.");
  if (!x.analysed || !y.analysed) throw new ResultsError("INVALID", "Both audits must be analysed before they can be compared.");
  const [base, head] = x.createdAt <= y.createdAt ? [x, y] : [y, x];
  const complete = await crawlComplete(db, head.crawlId, head.status);
  const wide = complete ? await wideAudits(db, head.crawlId) : [];
  // A fix verification between the two audits counts (the verification overlay, as in effectiveStates): its latest
  // result for a fingerprint, when resolved, resolves it here too, and an issue seen again after it is a regression.
  const r = await db.execute(sql`with k as (select id, created_at, workspace, ${projectKey("c")} as project from crawls c where id in (${base.crawlId}::uuid, ${head.crawlId}::uuid)),
      b as (select s.fingerprint, s.rule_id, s.url, s.page_subject,
          coalesce((select vs.state = 'resolved' from issue_states vs join crawls vc on vc.id = vs.crawl_id, k kb, k kh
            where kb.id = ${base.crawlId}::uuid and kh.id = ${head.crawlId}::uuid and vs.fingerprint = s.fingerprint and vc.kind = 'verify'
              and vc.workspace = kb.workspace and ${projectKey("vc")} = kb.project
              and (vc.created_at, vc.id) > (kb.created_at, kb.id) and (vc.created_at, vc.id) < (kh.created_at, kh.id)
            order by vc.created_at desc, vc.id desc limit 1), false) as verified
        from issue_states s where s.crawl_id = ${base.crawlId}::uuid and s.state in ('new', 'persistent', 'regressed', 'not_rechecked')),
      h as (select fingerprint, rule_id, outcome, first_seen_at from issue_states where crawl_id = ${head.crawlId}::uuid and outcome is not null),
      f as (select coalesce(b.rule_id, h.rule_id) as rule_id,
        case when h.outcome = 'inconclusive' then 'inconclusive'
             when b.fingerprint is not null and h.fingerprint is not null then case when b.verified then 'regressed' else 'persistent' end
             when b.fingerprint is null then case when h.first_seen_at < ${base.createdAt}::timestamptz then 'regressed' else 'new' end
             when b.verified or ${rechecked(head.crawlId, complete, wide, "b")} then 'resolved'
             else 'not_rechecked' end as change
        from b full join h on h.fingerprint = b.fingerprint)
    select rule_id, change, count(*)::int as n from f group by rule_id, change order by rule_id collate "C"`);
  const byRule = new Map<string, Record<FingerprintChange, number>>();
  for (const row of r.rows as { rule_id: string; change: FingerprintChange; n: number }[]) {
    const c = byRule.get(row.rule_id) ?? { new: 0, persistent: 0, resolved: 0, regressed: 0, not_rechecked: 0, inconclusive: 0 };
    c[row.change] = row.n;
    byRule.set(row.rule_id, c);
  }
  const groups: GroupComparison[] = [];
  const totals: Record<GroupChange, number> = { new: 0, persistent: 0, resolved: 0, regressed: 0, not_rechecked: 0 };
  for (const [ruleId, counts] of byRule) {
    const change: GroupChange | null = counts.persistent ? "persistent" : counts.regressed ? "regressed" : counts.new ? "new" : counts.not_rechecked ? "not_rechecked" : counts.resolved ? "resolved" : null;
    if (!change) continue; // inconclusive only: nothing to compare
    groups.push({ ruleId, change, counts });
    totals[change]++;
  }
  const warnings: string[] = [];
  if (base.profile !== head.profile) warnings.push(`The audits used different crawl profiles (${base.profile} and ${head.profile}).`);
  const cb = base.coverage.percent;
  const ch = head.coverage.percent;
  if (cb === null || ch === null || Math.abs(cb - ch) > SCOPE_TOLERANCE)
    warnings.push(`Coverage differs by more than ${SCOPE_TOLERANCE} points (${cb ?? "n/a"}% and ${ch ?? "n/a"}%): changes may reflect what was crawled, not what was fixed.`);
  return { base, head, groups, totals, scopeMismatch: warnings.length > 0, warnings };
}

export interface VerificationResult {
  verifyCrawlId: string;
  auditCrawlId: string;
  ruleId: string;
  status: string;
  analysed: boolean;
  createdAt: string;
  /** Target fingerprints. */
  targets: number;
  /** Target fingerprints per result state (empty until analysed). */
  states: Partial<Record<IssueState, number>>;
  urls: { url: string; state: IssueState }[];
}

/** A fix verification and its per-fingerprint results. */
export async function verificationResult(db: Exec, verifyCrawlId: string): Promise<VerificationResult> {
  const r = await db.execute(sql`select id, status, created_at, analysis->>'status' as analysis, config->'verify' as verify from crawls where id = ${verifyCrawlId}::uuid and kind = 'verify'`);
  const c = r.rows[0] as { id: string; status: string; created_at: Date | string; analysis: string | null; verify: { auditCrawlId: string; ruleId: string; fingerprints: string[] } } | undefined;
  if (!c) throw new ResultsError("NOT_FOUND", "Verification not found.");
  const rows = (await db.execute(sql`select url, state from issue_states where crawl_id = ${verifyCrawlId}::uuid order by url collate "C", fingerprint`)).rows as { url: string; state: IssueState }[];
  const states: Partial<Record<IssueState, number>> = {};
  for (const x of rows) states[x.state] = (states[x.state] ?? 0) + 1;
  return {
    verifyCrawlId: c.id,
    auditCrawlId: c.verify.auditCrawlId,
    ruleId: c.verify.ruleId,
    status: c.status,
    analysed: c.analysis === "completed",
    createdAt: new Date(c.created_at).toISOString(),
    targets: c.verify.fingerprints.length,
    states,
    urls: rows,
  };
}

/** The latest verification of an audit's issue group, or null. */
export async function latestVerification(db: Exec, auditCrawlId: string, ruleId: string): Promise<VerificationResult | null> {
  const r = await db.execute(sql`select id from crawls where kind = 'verify' and config->'verify'->>'auditCrawlId' = ${auditCrawlId} and config->'verify'->>'ruleId' = ${ruleId}
    order by created_at desc, id desc limit 1`);
  const id = (r.rows[0] as { id: string } | undefined)?.id;
  return id ? verificationResult(db, id) : null;
}

/** The open fingerprints (effective state) of an audit's issue group: what a verification targets. */
export async function openFingerprints(db: Exec, auditCrawlId: string, ruleId: string): Promise<{ fingerprint: string; url: string }[]> {
  const open = sql.raw(OPEN_STATES.map((x) => `'${x}'`).join(", "));
  const r = await db.execute(sql`select fingerprint, url from ${effectiveStates(auditCrawlId)} e where e.rule_id = ${ruleId} and e.state in (${open}) order by url collate "C", fingerprint`);
  return r.rows as { fingerprint: string; url: string }[];
}

// ---------- report sections (src/lib/results/report.ts): stored rows only ----------

export interface EvidenceSample {
  url: string;
  message: string;
  evidence: Record<string, unknown>;
  outcome: string;
}

/** The first `perGroup` findings (by URL) of each rule: the evidence a report shows beside a group. */
export async function groupEvidence(db: Exec, crawlId: string, ruleIds: string[], perGroup = 3): Promise<Map<string, EvidenceSample[]>> {
  const out = new Map<string, EvidenceSample[]>();
  if (!ruleIds.length) return out;
  const r = await db.execute(sql`select rule_id, url, message, evidence, outcome from (
      select f.*, row_number() over (partition by rule_id order by url collate "C", id) as n from findings f
      where crawl_id = ${crawlId}::uuid and rule_id in (${sql.join(ruleIds.map((x) => sql`${x}`), sql`, `)})) x
    where n <= ${perGroup} order by rule_id collate "C", n`);
  for (const x of r.rows as unknown as (EvidenceSample & { rule_id: string })[]) {
    if (!out.has(x.rule_id)) out.set(x.rule_id, []);
    out.get(x.rule_id)!.push({ url: x.url, message: x.message, evidence: x.evidence, outcome: x.outcome });
  }
  return out;
}

/** Every URL an issue group affects (outcome issue), with its effective state: the count is the group's affectedUrls. */
export async function affectedUrlList(db: Exec, crawlId: string, ruleId: string, limit?: number): Promise<{ url: string; state: IssueState }[]> {
  const r = await db.execute(sql`select o.url, min(e.state) as state from finding_occurrences o
      join ${effectiveStates(crawlId)} e on e.fingerprint = o.fingerprint
    where o.crawl_id = ${crawlId}::uuid and o.rule_id = ${ruleId} and o.outcome = 'issue' group by o.url order by o.url collate "C" ${limit === undefined ? sql`` : sql`limit ${limit}`}`);
  return r.rows as { url: string; state: IssueState }[];
}

export interface RuleRunRow {
  ruleId: string;
  version: number;
  status: string;
  evaluated: number;
  findings: number;
  detail: string | null;
}

/** What ran in the analysis, and what did not (needs_config, error) with the reason. */
export async function ruleRunList(db: Exec, crawlId: string): Promise<RuleRunRow[]> {
  const r = await db.execute(sql`select rule_id, rule_version, status, evaluated, findings, detail from rule_runs where crawl_id = ${crawlId}::uuid order by rule_id collate "C"`);
  return (r.rows as { rule_id: string; rule_version: number; status: string; evaluated: number; findings: number; detail: string | null }[]).map((x) => ({
    ruleId: x.rule_id,
    version: Number(x.rule_version),
    status: x.status,
    evaluated: Number(x.evaluated),
    findings: Number(x.findings),
    detail: x.detail,
  }));
}

/** URLs per link depth from the seeds (null: found only in sitemaps), and how many of them were answered. */
export async function depthHistogram(db: Exec, crawlId: string): Promise<{ depth: number | null; urls: number; answered: number }[]> {
  const answered = sql.raw(ANSWERED.map((x) => `'${x}'`).join(", "));
  const r = await db.execute(sql`select depth, count(*)::int as urls, count(*) filter (where state in (${answered}))::int as answered from crawl_urls
    where crawl_id = ${crawlId}::uuid group by depth order by depth nulls last`);
  return (r.rows as { depth: number | null; urls: number; answered: number }[]).map((x) => ({ depth: x.depth === null ? null : Number(x.depth), urls: x.urls, answered: x.answered }));
}

export interface DuplicateCluster {
  ruleId: string;
  /** What the pages share: the title, the description, the content hash, or "near-duplicate". */
  key: string;
  urls: string[];
}

/** Duplicate clusters from the duplicate rules' evidence: exact (CNT-006, META-004, META-009) and near (CNT-007, joined pairs). */
export async function duplicateClusters(db: Exec, crawlId: string): Promise<DuplicateCluster[]> {
  const exact = await db.execute(sql`select rule_id, key, array_agg(url order by url collate "C") as urls from (
      select rule_id, url, coalesce(evidence->>'title', evidence->>'description', evidence->>'textHash') as key from findings
      where crawl_id = ${crawlId}::uuid and rule_id in ('CNT-006', 'META-004', 'META-009') and outcome = 'issue') f
    group by rule_id, key order by count(*) desc, rule_id collate "C", key collate "C"`);
  const out = (exact.rows as { rule_id: string; key: string; urls: string[] }[]).map((x) => ({ ruleId: x.rule_id, key: x.key, urls: x.urls }));
  // Near duplicates are pairs; a cluster is a connected set of pages.
  const near = await db.execute(sql`select url, evidence->'matches' as matches from findings where crawl_id = ${crawlId}::uuid and rule_id = 'CNT-007' and outcome = 'issue'`);
  const parent = new Map<string, string>();
  const find = (u: string): string => {
    const p = parent.get(u) ?? u;
    if (p === u) return u;
    const root = find(p);
    parent.set(u, root);
    return root;
  };
  for (const x of near.rows as { url: string; matches: { url: string }[] | null }[]) {
    parent.set(x.url, parent.get(x.url) ?? x.url);
    for (const m of x.matches ?? []) {
      parent.set(m.url, parent.get(m.url) ?? m.url);
      const [a, b] = [find(x.url), find(m.url)];
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
  }
  const clusters = new Map<string, string[]>();
  for (const u of parent.keys()) {
    const root = find(u);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root)!.push(u);
  }
  const nearClusters = [...clusters.values()].map((urls) => urls.sort()).sort((a, b) => b.length - a.length || (a[0] < b[0] ? -1 : 1));
  return [...out, ...nearClusters.map((urls) => ({ ruleId: "CNT-007", key: "near-duplicate", urls }))];
}
