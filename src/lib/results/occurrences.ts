// From findings to occurrences and issue groups (docs/HEALTH-SCORE.md). `occurrenceOf` is pure, so the fixture
// simulation (fixtures/site/site-rules.test.ts) builds the same rows as the analysis job.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { isIndexable, type Finding, type Rule, type SiteView } from "../rules/contract";
import { fingerprintOf } from "../rules/fingerprint";
import { CONFIDENCE_WEIGHT, priorityOf, priorityScore, reach } from "./priority";
import { onlyRules } from "./states";

type Exec = Pick<Db, "execute">;

/** Sample URLs stored per issue group and per template within it. */
export const SAMPLE_URLS = 5;

export interface Occurrence {
  fingerprint: string;
  ruleId: string;
  url: string;
  evidenceKey: string;
  templateId: string | null;
  outcome: Finding["outcome"];
  /** See finding_occurrences.reach_pages. */
  reachPages: number | null;
}

/** What occurrences need to know about the crawl. */
export interface ReachBasis {
  /** Every URL of the crawl inventory by normalised URL. */
  byUrl: SiteView["byUrl"];
  /** Indexable HTML pages (contract.isIndexable): the reach denominator. */
  indexable: number;
}

export function reachBasis(site: SiteView): ReachBasis {
  let indexable = 0;
  for (const u of site.urls) if (isIndexable(u)) indexable++;
  return { byUrl: site.byUrl, indexable };
}

/**
 * Pages an occurrence counts toward reach: the evidence's page count when the finding stands for several pages
 * (a resource used on N pages, a template-wide defect); else 1 for an indexable page or a URL that is not an HTML page
 * (a 404, a redirect), 0 for an HTML page that is not indexable (noindex, canonicalised elsewhere); null when the
 * subject is not a URL of the crawl (robots.txt, a sitemap, llms.txt): a site-wide finding.
 */
export function reachPagesOf(f: Finding, basis: ReachBasis): number | null {
  const pages = f.evidence.pages;
  if (typeof pages === "number" && Number.isFinite(pages)) return Math.max(0, Math.min(Math.round(pages), basis.indexable));
  const u = basis.byUrl.get(f.url);
  if (!u) return null;
  if (!u.page) return 1;
  return isIndexable(u) ? 1 : 0;
}

export function occurrenceOf(rule: Rule | undefined, f: Finding, basis: ReachBasis): Occurrence {
  const { fingerprint, key } = fingerprintOf(rule, f);
  return {
    fingerprint,
    ruleId: f.ruleId,
    url: f.url,
    evidenceKey: key,
    templateId: basis.byUrl.get(f.url)?.page?.template ?? null,
    outcome: f.outcome,
    reachPages: reachPagesOf(f, basis),
  };
}

/**
 * Stores occurrences; a second occurrence with a fingerprint already stored for the crawl is dropped (the rule's
 * evidence key does not tell them apart: a rule bug the fixture collision test guards against). Returns rows dropped.
 */
export async function insertOccurrences(db: Exec, crawlId: string, rows: Occurrence[], batch = 500): Promise<number> {
  let dropped = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const part = rows.slice(i, i + batch);
    const r = await db.execute(sql`insert into finding_occurrences (crawl_id, fingerprint, rule_id, url, evidence_key, template_id, outcome, reach_pages)
      select ${crawlId}::uuid, v.fingerprint, v.rule_id, v.url, v.evidence_key, v.template_id, v.outcome, v.reach_pages
      from jsonb_to_recordset(${JSON.stringify(part.map((o) => ({ fingerprint: o.fingerprint, rule_id: o.ruleId, url: o.url, evidence_key: o.evidenceKey, template_id: o.templateId, outcome: o.outcome, reach_pages: o.reachPages })))}::jsonb)
        as v(fingerprint text, rule_id text, url text, evidence_key text, template_id text, outcome text, reach_pages int)
      on conflict (crawl_id, fingerprint) do nothing`);
    dropped += part.length - (r.rowCount ?? part.length);
  }
  return dropped;
}

export interface GroupInputs {
  ruleId: string;
  affectedUrls: number;
  inconclusiveUrls: number;
  /** Sum of reach pages over issue occurrences: distinct URLs counting 1, plus evidence page counts; null = site-wide. */
  affectedPages: number | null;
}

/** Priority inputs, score and band for one rule's group (docs/HEALTH-SCORE.md). */
export function groupPriority(rule: Pick<Rule, "impact" | "confidence" | "category">, g: GroupInputs, indexable: number) {
  const affectedPages = g.affectedPages === null ? indexable : Math.min(g.affectedPages, indexable);
  const r = g.affectedUrls ? reach(affectedPages, indexable) : 0;
  const score = priorityScore(rule.impact, r, rule.confidence);
  return {
    category: rule.category,
    impact: rule.impact,
    confidence: rule.confidence,
    confidenceWeight: CONFIDENCE_WEIGHT[rule.confidence],
    affectedPages: g.affectedUrls ? affectedPages : 0,
    indexablePages: indexable,
    reach: Math.round(r * 10000) / 10000,
    score,
    priority: priorityOf(score),
  };
}

/** One issue group per rule with an occurrence in the crawl, from finding_occurrences. `ruleIds`: only those rules'. */
export async function writeIssueGroups(db: Exec, crawlId: string, rules: Rule[], indexable: number, ruleIds?: string[]): Promise<number> {
  const only = onlyRules("rule_id", ruleIds);
  const byId = new Map(rules.map((r) => [r.id, r]));
  const r = await db.execute(sql`select rule_id,
      count(distinct url) filter (where outcome = 'issue')::int as affected_urls,
      count(distinct url) filter (where outcome = 'inconclusive')::int as inconclusive_urls,
      coalesce(bool_or(reach_pages is null) filter (where outcome = 'issue'), false) as site_wide,
      (count(distinct url) filter (where outcome = 'issue' and reach_pages = 1) + coalesce(sum(reach_pages) filter (where outcome = 'issue' and reach_pages > 1), 0))::int as pages
    from finding_occurrences where crawl_id = ${crawlId}::uuid ${only} group by rule_id order by rule_id`);
  const rows = (r.rows as { rule_id: string; affected_urls: number; inconclusive_urls: number; site_wide: boolean; pages: number }[]).flatMap((x) => {
    const rule = byId.get(x.rule_id);
    // A group with no affected URL is empty: only inconclusive findings, which the rule run still counts.
    if (!rule || x.affected_urls === 0) return [];
    const p = groupPriority(rule, { ruleId: x.rule_id, affectedUrls: x.affected_urls, inconclusiveUrls: x.inconclusive_urls, affectedPages: x.site_wide ? null : x.pages }, indexable);
    return [
      {
        rule_id: x.rule_id,
        category: p.category,
        impact: p.impact,
        confidence: p.confidence,
        confidence_weight: p.confidenceWeight,
        affected_pages: p.affectedPages,
        indexable_pages: p.indexablePages,
        reach: p.reach,
        score: p.score,
        priority: p.priority,
        affected_urls: x.affected_urls,
        inconclusive_urls: x.inconclusive_urls,
      },
    ];
  });
  if (!rows.length) return 0;
  // Rule, then template: the affected URLs per template, and the first few of each.
  await db.execute(sql`with o as (select distinct rule_id, coalesce(template_id, '') as t, url from finding_occurrences where crawl_id = ${crawlId}::uuid and outcome = 'issue' ${only}),
      r as (select *, row_number() over (partition by rule_id, t order by url collate "C") as rn from o)
    insert into issue_group_templates (crawl_id, rule_id, template_id, affected_urls, sample_urls)
    select ${crawlId}::uuid, rule_id, t, count(*)::int, jsonb_agg(url order by url collate "C") filter (where rn <= ${SAMPLE_URLS}) from r group by rule_id, t`);
  await db.execute(sql`insert into issue_groups (crawl_id, rule_id, category, impact, confidence, confidence_weight, affected_pages, indexable_pages, reach, score, priority, affected_urls, inconclusive_urls)
    select ${crawlId}::uuid, v.rule_id, v.category, v.impact, v.confidence, v.confidence_weight, v.affected_pages, v.indexable_pages, v.reach, v.score, v.priority, v.affected_urls, v.inconclusive_urls
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as v(rule_id text, category text, impact smallint, confidence text, confidence_weight real, affected_pages int, indexable_pages int, reach real, score real, priority text, affected_urls int, inconclusive_urls int)`);
  await db.execute(sql`with o as (select distinct rule_id, url, template_id from finding_occurrences where crawl_id = ${crawlId}::uuid and outcome = 'issue' ${only}),
      r as (select *, row_number() over (partition by rule_id order by url collate "C") as rn from o)
    update issue_groups g set template_count = x.n, sample_urls = x.sample
    from (select rule_id, count(distinct template_id)::int as n, jsonb_agg(url order by url collate "C") filter (where rn <= ${SAMPLE_URLS}) as sample from r group by rule_id) x
    where g.crawl_id = ${crawlId}::uuid and g.rule_id = x.rule_id`);
  return rows.length;
}
