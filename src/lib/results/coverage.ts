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

/** Why a crawl did not cover everything in scope. */
export interface CoverageReason {
  code: "budget" | "depth" | "robots" | "failures" | "interrupted" | "cancelled" | "failed" | "not_reached";
  urls: number;
  message: string;
}

export interface CoverageVerdict {
  /** complete: every in-scope URL reached a final state and no budget cut applied. running: not finished yet. */
  verdict: "complete" | "partial" | "running";
  reasons: CoverageReason[];
  /** URLs the site or the audit itself ruled out: stated, but not a coverage gap (robots.txt rules, scope). */
  notes: string[];
}

const FAILURE_LABEL: Record<string, string> = { failed_timeout: "timed out", failed_dns: "DNS failure", failed_tls: "TLS failure", failed_network: "network failure" };
const urlCount = (n: number) => `${n.toLocaleString("en-GB")} URL${n === 1 ? "" : "s"}`;

/**
 * Complete or partial, and exactly why, from the crawl's URL states. A URL robots.txt disallows is in a final state
 * and is the site's own choice, so on its own it is a note; a robots.txt that blocked the whole crawl is a reason.
 */
export function coverageVerdict(
  states: Record<string, number>,
  crawl: { status: string; budget: number | null; maxDepth: number | null; robots: { outcome?: string; reason?: string } | null; apiEndpoints?: { found: number; fetched: number } | null },
): CoverageVerdict {
  if (["queued", "running", "paused", "cancelling"].includes(crawl.status)) return { verdict: "running", reasons: [], notes: [] };
  const n = (s: string) => states[s] ?? 0;
  const reasons: CoverageReason[] = [];
  const notes: string[] = [];
  if (crawl.status === "failed") reasons.push({ code: "failed", urls: 0, message: "Crawl error: the crawl stopped before it finished." });
  if (n("budget_exhausted")) reasons.push({ code: "budget", urls: n("budget_exhausted"), message: `Budget reached: ${urlCount(n("budget_exhausted"))} found but not fetched, because the ${(crawl.budget ?? 0).toLocaleString("en-GB")}-URL budget ran out.` });
  if (n("depth_exceeded")) reasons.push({ code: "depth", urls: n("depth_exceeded"), message: `Depth limit: ${urlCount(n("depth_exceeded"))} more than ${crawl.maxDepth ?? 0} clicks from the start URL not fetched.` });
  if (n("blocked_robots")) {
    if (crawl.robots?.outcome === "disallow_all") reasons.push({ code: "robots", urls: n("blocked_robots"), message: `robots.txt: ${urlCount(n("blocked_robots"))} not fetched. ${crawl.robots.reason ?? "It disallows the whole site."}` });
    else notes.push(`robots.txt disallows ${urlCount(n("blocked_robots"))}, so they were not fetched.`);
  }
  const failures = Object.keys(FAILURE_LABEL).filter((s) => n(s));
  if (failures.length) {
    const total = failures.reduce((a, s) => a + n(s), 0);
    reasons.push({ code: "failures", urls: total, message: `Failures: ${urlCount(total)} could not be fetched (${failures.map((s) => `${n(s).toLocaleString("en-GB")} ${FAILURE_LABEL[s]}`).join(", ")}).` });
  }
  if (n("interrupted")) reasons.push({ code: "interrupted", urls: n("interrupted"), message: `Interrupted: ${urlCount(n("interrupted"))} were being fetched when the crawl stopped.` });
  if (n("cancelled") || crawl.status === "cancelled") reasons.push({ code: "cancelled", urls: n("cancelled"), message: `Cancelled: the crawl was stopped by hand with ${urlCount(n("cancelled"))} not fetched.` });
  const active = n("discovered") + n("queued") + n("fetching");
  if (active) reasons.push({ code: "not_reached", urls: active, message: `Not reached: ${urlCount(active)} still waiting when the crawl ended.` });
  if (n("excluded_by_rule")) notes.push(`This audit's scope rules excluded ${urlCount(n("excluded_by_rule"))}.`);
  if (n("out_of_scope")) notes.push(`${urlCount(n("out_of_scope"))} outside the audit's scope (another host or subfolder) not fetched.`);
  const api = crawl.apiEndpoints;
  if (api?.found) notes.push(`API/feed endpoints: ${api.found.toLocaleString("en-GB")} (${api.fetched.toLocaleString("en-GB")} fetched). These are URLs for machines (wp-json, oEmbed, feeds, XML-RPC), where noindex is correct, so the indexability checks skip them.`);
  return { verdict: reasons.length ? "partial" : "complete", reasons, notes };
}
