// Checks a rendered report against the database: every data-metric in the HTML is recomputed here with its own SQL
// over the raw tables (crawl_urls, finding_occurrences, issue_states, issue_groups, rule_runs, crawls), not through
// report.ts. Used by the report tests and by gate:p3. A key this module cannot recompute is a failure, not a skip.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { ANSWERED, NOT_OURS } from "../results/coverage";
import { compareCrawls, duplicateClusters, effectiveStates, type Comparison, type CrawlOverview, type IssueGroupRow } from "../results/queries";
import { PRIORITY_PAGES } from "../results/report";
import { previousAudit } from "../results/states";

type Exec = Pick<Db, "execute">;

/** Every data-metric in the HTML, in document order. */
export function reportMetrics(html: string): { key: string; value: string }[] {
  return [...html.matchAll(/<span data-metric="([^"]+)">([^<]*)<\/span>/g)].map((x) => ({ key: x[1].replace(/&amp;/g, "&"), value: x[2] }));
}

const one = async (db: Exec, q: ReturnType<typeof sql>) => {
  const row = (await db.execute(q)).rows[0] as { v: unknown } | undefined;
  return row?.v === null || row?.v === undefined ? "n/a" : String(row.v);
};

const list = (xs: string[]) => sql.raw(xs.map((x) => `'${x}'`).join(", "));

/** The database's value for one metric key, as the report prints it. */
export async function databaseMetric(db: Exec, crawlId: string, key: string): Promise<string> {
  const c = sql`${crawlId}::uuid`;
  let x: RegExpMatchArray | null;
  if ((x = key.match(/^coverage\.state\.(\w+)$/))) return one(db, sql`select count(*)::int as v from crawl_urls where crawl_id = ${c} and state = ${x[1]}`);
  if (key === "coverage.total") return one(db, sql`select count(*)::int as v from crawl_urls where crawl_id = ${c}`);
  if (key === "coverage.answered") return one(db, sql`select count(*)::int as v from crawl_urls where crawl_id = ${c} and state in (${list(ANSWERED)})`);
  if (key === "coverage.eligible") return one(db, sql`select count(*)::int as v from crawl_urls where crawl_id = ${c} and state not in (${list(NOT_OURS)})`);
  if (key === "coverage.percent")
    return one(db, sql`select case when e = 0 then null else round(1000.0 * a / e) / 10 end::float8 as v from (select count(*) filter (where state in (${list(ANSWERED)})) as a,
      count(*) filter (where state not in (${list(NOT_OURS)})) as e from crawl_urls where crawl_id = ${c}) t`);
  if ((x = key.match(/^group\.([A-Z0-9]+-\d{3})\.(affected|inconclusive)$/)))
    return one(db, sql`select count(distinct url)::int as v from finding_occurrences where crawl_id = ${c} and rule_id = ${x[1]} and outcome = ${x[2] === "affected" ? "issue" : "inconclusive"}`);
  if ((x = key.match(/^group\.([A-Z0-9]+-\d{3})\.templates$/))) return one(db, sql`select template_count as v from issue_groups where crawl_id = ${c} and rule_id = ${x[1]}`);
  if ((x = key.match(/^group\.([A-Z0-9]+-\d{3})\.score$/))) return one(db, sql`select score as v from issue_groups where crawl_id = ${c} and rule_id = ${x[1]}`);
  if ((x = key.match(/^group\.([A-Z0-9]+-\d{3})\.state\.(\w+)$/))) return one(db, sql`select count(*)::int as v from ${effectiveStates(crawlId)} e where e.rule_id = ${x[1]} and e.state = ${x[2]}`);
  if ((x = key.match(/^states\.(\w+)$/))) return one(db, sql`select count(*)::int as v from ${effectiveStates(crawlId)} e where e.state = ${x[1]}`);
  if (key === "verifiedResolved") return one(db, sql`select count(*)::int as v from ${effectiveStates(crawlId)} e where e.verify_state = 'resolved'`);
  if (key === "issueGroups") return one(db, sql`select count(*)::int as v from issue_groups where crawl_id = ${c} and affected_urls > 0`);
  if ((x = key.match(/^priority\.(\w+)$/))) return one(db, sql`select count(*)::int as v from issue_groups where crawl_id = ${c} and affected_urls > 0 and priority = ${x[1]}`);
  if (key === "priorityPages") return one(db, sql`select least(count(*), ${PRIORITY_PAGES})::int as v from issue_groups where crawl_id = ${c} and affected_urls > 0 and priority <> 'info'`);
  if (key === "rulesRan") return one(db, sql`select count(*)::int as v from rule_runs where crawl_id = ${c} and status = 'ran'`);
  if (key === "rulesNotRan") return one(db, sql`select count(*)::int as v from rule_runs where crawl_id = ${c} and status <> 'ran'`);
  if (key === "health.score") return one(db, sql`select (health->>'score')::float8 as v from crawls where id = ${c}`);
  if ((x = key.match(/^health\.category\.(\w+)$/))) return one(db, sql`select (health->'categories'->${x[1]}->>'score')::float8 as v from crawls where id = ${c}`);
  if (key === "crawl.fetchesCommitted") return one(db, sql`select fetches_committed as v from crawls where id = ${c}`);
  if ((x = key.match(/^resources\.(external|images)\.(found|planned)$/))) return one(db, sql`select (resources->${x[1]}->>${x[2]})::int as v from crawls where id = ${c}`);
  if ((x = key.match(/^depth\.(\d+|sitemap)$/)))
    return one(db, x[1] === "sitemap" ? sql`select count(*)::int as v from crawl_urls where crawl_id = ${c} and depth is null` : sql`select count(*)::int as v from crawl_urls where crawl_id = ${c} and depth = ${Number(x[1])}`);
  // Clusters and comparisons are themselves queries (the API's): the report must print what they return.
  if (key === "duplicates.clusters") return String((await duplicateClusters(db, crawlId)).length);
  if ((x = key.match(/^compare\.(\w+)$/))) {
    const base = await previousAudit(db, crawlId);
    if (!base) throw new Error("compare.* metric without a previous audit");
    return String((await compareCrawls(db, base, crawlId)).totals[x[1] as "new"]);
  }
  throw new Error(`No database check for report metric "${key}"`);
}

export interface MetricCheck {
  checked: number;
  keys: number;
  mismatches: { key: string; report: string; database: string }[];
}

/** Compares every metric of a rendered report with the database. */
export async function checkReportMetrics(db: Exec, crawlId: string, html: string): Promise<MetricCheck> {
  const metrics = reportMetrics(html);
  const cache = new Map<string, string>();
  const mismatches: MetricCheck["mismatches"] = [];
  for (const { key, value } of metrics) {
    if (!cache.has(key)) cache.set(key, await databaseMetric(db, crawlId, key));
    const want = cache.get(key)!;
    if (Number.isFinite(Number(value)) && Number.isFinite(Number(want)) ? Number(value) !== Number(want) : value !== want) mismatches.push({ key, report: value, database: want });
  }
  return { checked: metrics.length, keys: cache.size, mismatches };
}

/** The value the API returns for a report metric key, or undefined when no API response carries it. */
export function apiMetric(api: { overview: CrawlOverview; groups: IssueGroupRow[]; comparison: Comparison | null }, key: string): string | undefined {
  const o = api.overview;
  const s = (v: number | null | undefined) => (v === null || v === undefined ? "n/a" : String(v));
  let x: RegExpMatchArray | null;
  if (key === "health.score") return s(o.health?.score);
  if ((x = key.match(/^health\.category\.(\w+)$/))) return s(o.health?.categories[x[1] as keyof NonNullable<CrawlOverview["health"]>["categories"]]?.score);
  if ((x = key.match(/^coverage\.state\.(\w+)$/))) return s(o.coverage.states[x[1]] ?? 0);
  if (key === "coverage.total") return s(o.coverage.total);
  if (key === "coverage.answered") return s(o.coverage.answered);
  if (key === "coverage.eligible") return s(o.coverage.eligible);
  if (key === "coverage.percent") return s(o.coverage.percent);
  if ((x = key.match(/^states\.(\w+)$/))) return s(o.states[x[1] as keyof CrawlOverview["states"]]);
  if (key === "verifiedResolved") return s(o.verifiedResolved);
  if (key === "issueGroups") return s(o.issueGroups);
  if ((x = key.match(/^priority\.(\w+)$/))) return s(o.priorities[x[1] as keyof CrawlOverview["priorities"]]);
  if (key === "rulesRan") return s(o.rulesRan);
  if ((x = key.match(/^group\.([A-Z0-9]+-\d{3})\.(\w+)(?:\.(\w+))?$/))) {
    const g = api.groups.find((y) => y.ruleId === x![1]);
    if (!g) return "missing";
    if (x[2] === "affected") return s(g.affectedUrls);
    if (x[2] === "inconclusive") return s(g.inconclusiveUrls);
    if (x[2] === "templates") return s(g.templateCount);
    if (x[2] === "score") return s(g.score);
    if (x[2] === "state") return s(g.states[x[3] as keyof IssueGroupRow["states"]] ?? 0);
  }
  if ((x = key.match(/^compare\.(\w+)$/))) return api.comparison ? s(api.comparison.totals[x[1] as keyof Comparison["totals"]]) : "missing";
  return undefined;
}

/** Compares the report's metrics with the API's responses: `apiBacked` keys must match, the rest are listed. */
export function checkAgainstApi(html: string, api: Parameters<typeof apiMetric>[0]): { apiBacked: number; notInApi: string[]; mismatches: { key: string; report: string; api: string }[] } {
  const notInApi = new Set<string>();
  const mismatches: { key: string; report: string; api: string }[] = [];
  let apiBacked = 0;
  for (const { key, value } of reportMetrics(html)) {
    const want = apiMetric(api, key);
    if (want === undefined) {
      notInApi.add(key.replace(/\.\d+$/, ".N"));
      continue;
    }
    apiBacked++;
    if (Number.isFinite(Number(value)) && Number.isFinite(Number(want)) ? Number(value) !== Number(want) : value !== want) mismatches.push({ key, report: value, api: want });
  }
  return { apiBacked, notInApi: [...notInApi].sort(), mismatches };
}
