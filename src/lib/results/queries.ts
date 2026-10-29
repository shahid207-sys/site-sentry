// The read side of a v2 crawl's results: one module for the API and the report, so every number shown anywhere
// comes from the same query.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { IssueState } from "../db/schema";
import type { Priority } from "./priority";
import { crawlComplete, crawlCoverage, type Coverage } from "./coverage";
import type { Health } from "./health";
import { projectKey, rechecked, stateCounts, type StateCounts } from "./states";

type Exec = Pick<Db, "execute">;

export class ResultsError extends Error {
  constructor(
    public code: "NOT_FOUND" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

export interface CrawlOverview {
  crawlId: string;
  workspace: string;
  project: string;
  siteOrigin: string;
  profile: string;
  status: string;
  createdAt: string;
  analysed: boolean;
  coverage: Coverage;
  health: Health | null;
  /** issue_states per state. */
  states: StateCounts;
  /** Issue groups with at least one affected URL, per priority. */
  priorities: Record<Priority, number>;
  issueGroups: number;
  /** Rules with rule_runs status 'ran'. */
  rulesRan: number;
}

export async function crawlOverview(db: Exec, crawlId: string): Promise<CrawlOverview> {
  const r = await db.execute(sql`select id, workspace, ${projectKey("c")} as project, site_origin, profile, status, created_at, analysis->>'status' as analysis, health
    from crawls c where id = ${crawlId}::uuid`);
  const c = r.rows[0] as { id: string; workspace: string; project: string; site_origin: string; profile: string; status: string; created_at: Date | string; analysis: string | null; health: Health | null } | undefined;
  if (!c) throw new ResultsError("NOT_FOUND", "Crawl not found.");
  const g = await db.execute(sql`select priority, count(*)::int as n from issue_groups where crawl_id = ${crawlId}::uuid and affected_urls > 0 group by priority`);
  const priorities: Record<Priority, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
  for (const x of g.rows as { priority: Priority; n: number }[]) priorities[x.priority] = x.n;
  const ran = await db.execute(sql`select count(*)::int as n from rule_runs where crawl_id = ${crawlId}::uuid and status = 'ran'`);
  return {
    crawlId: c.id,
    workspace: c.workspace,
    project: c.project,
    siteOrigin: c.site_origin,
    profile: c.profile,
    status: c.status,
    createdAt: new Date(c.created_at).toISOString(),
    analysed: c.analysis === "completed",
    coverage: await crawlCoverage(db, crawlId),
    health: c.health,
    states: await stateCounts(db, crawlId),
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
      coalesce((select jsonb_object_agg(x.state, x.n) from (select state, count(*)::int as n from issue_states s where s.crawl_id = g.crawl_id and s.rule_id = g.rule_id group by state) x), '{}'::jsonb) as states
    from issue_groups g where g.crawl_id = ${crawlId}::uuid and g.affected_urls > 0 ${only}
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
 * open in the base audit and observed again as an issue → persistent; observed inconclusive → inconclusive; not
 * observed → resolved when the newer audit re-checked it (`rechecked`), else not_rechecked; an issue observed only in
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
  const r = await db.execute(sql`with b as (select fingerprint, rule_id, url from issue_states where crawl_id = ${base.crawlId}::uuid and state in ('new', 'persistent', 'regressed', 'not_rechecked')),
      h as (select fingerprint, rule_id, outcome, first_seen_at from issue_states where crawl_id = ${head.crawlId}::uuid and outcome is not null),
      f as (select coalesce(b.rule_id, h.rule_id) as rule_id,
        case when h.outcome = 'inconclusive' then 'inconclusive'
             when b.fingerprint is not null and h.fingerprint is not null then 'persistent'
             when b.fingerprint is null then case when h.first_seen_at < ${base.createdAt}::timestamptz then 'regressed' else 'new' end
             when ${rechecked(head.crawlId, complete, "b")} then 'resolved'
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
