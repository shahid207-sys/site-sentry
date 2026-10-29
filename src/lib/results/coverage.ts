// What a crawl covered: one definition for the analysis job, the API, the report and the validation script.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";

type Exec = Pick<Db, "execute">;

/**
 * URL states that mean a URL of the crawled host was never fetched for a reason other than the site's own rules
 * (robots.txt, scope): graph rules cannot prove an absence (no inbound links) when any exists.
 */
export const UNFETCHED = ["budget_exhausted", "depth_exceeded", "cancelled", "interrupted", "failed_timeout", "failed_network", "failed_dns", "failed_tls"];

/** URL states that mean the URL was requested and answered. */
export const ANSWERED = ["fetched", "analysed", "redirected", "non_html", "oversized"];

/**
 * States the site owner or the audit's own rules ruled out; the only ones not counted against coverage. Everything
 * else found counts, including out_of_scope (reported by reason: another host is usually the site's www/apex twin,
 * which is a coverage miss, not a choice) and budget_exhausted / depth_exceeded (found but not reached).
 */
export const NOT_OURS = ["blocked_robots", "excluded_by_rule", "cdn_managed"];

/** A completed crawl that left no URL of the host unfetched. */
export async function crawlComplete(db: Exec, crawlId: string, status: string): Promise<boolean> {
  if (status !== "completed") return false;
  const r = await db.execute(sql`select exists (select 1 from crawl_urls where crawl_id = ${crawlId}::uuid and state in (${sql.join(UNFETCHED.map((s) => sql`${s}`), sql`, `)})) as partial`);
  return !(r.rows[0] as { partial: boolean }).partial;
}

export interface Coverage {
  /** URLs found, per state. */
  states: Record<string, number>;
  total: number;
  answered: number;
  /** Every URL found except NOT_OURS. */
  eligible: number;
  /** answered / eligible × 100, one decimal; null when nothing is eligible. */
  percent: number | null;
}

export function coverageOf(states: Record<string, number>): Coverage {
  const sum = (keys: string[]) => keys.reduce((n, k) => n + (states[k] ?? 0), 0);
  const total = Object.values(states).reduce((a, b) => a + b, 0);
  const answered = sum(ANSWERED);
  const eligible = total - sum(NOT_OURS);
  return { states, total, answered, eligible, percent: eligible ? Math.round((1000 * answered) / eligible) / 10 : null };
}

export async function crawlCoverage(db: Exec, crawlId: string): Promise<Coverage> {
  const r = await db.execute(sql`select state, count(*)::int as n from crawl_urls where crawl_id = ${crawlId}::uuid group by state`);
  return coverageOf(Object.fromEntries((r.rows as { state: string; n: number }[]).map((x) => [x.state, x.n])));
}
