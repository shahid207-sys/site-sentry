// Row-level reads for the app's explorer screens (Phase 4): every finding of an audit with its effective state, every
// crawled URL with its page facts, and everything known about one URL. Reads only; the numbers agree with the
// overview, issue groups and report because they come from the same tables and the same verification overlay.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { IssueState } from "../db/schema";
import { effectiveStates } from "./queries";
import { OPEN_STATES, projectKey } from "./states";

type Exec = Pick<Db, "execute">;

/** One fingerprint of an audit, as the Issues explorer lists it. */
export interface IssueRow {
  fingerprint: string;
  ruleId: string;
  url: string;
  state: IssueState;
  /** What the audit observed: an issue, or could not judge (inconclusive); null when carried over unobserved. */
  outcome: "issue" | "inconclusive" | null;
  templateId: string | null;
  /**
   * The finding's message in this audit; null when the audit did not observe it (e.g. not_rechecked), and on the
   * whole-audit list (issueRows without a rule), which stays small enough to filter 50k rows in the browser.
   */
  message: string | null;
  /** True when a later fix verification resolved it (the state shown is then resolved). */
  verified: boolean;
}

/** Every fingerprint of the audit, open or not, ordered by rule then URL; only rule `ruleId`'s, with messages, when given. */
export async function issueRows(db: Exec, crawlId: string, ruleId?: string): Promise<IssueRow[]> {
  const message =
    ruleId === undefined
      ? sql`null::text`
      : sql`(select left(f.message, 300) from findings f where f.crawl_id = ${crawlId}::uuid and f.fingerprint = e.fingerprint order by f.id limit 1)`;
  const r = await db.execute(sql`select e.fingerprint, e.rule_id, e.url, e.state, e.outcome, e.template_id, e.verify_state, ${message} as message
    from ${effectiveStates(crawlId)} e ${ruleId === undefined ? sql`` : sql`where e.rule_id = ${ruleId}`} order by e.rule_id collate "C", e.url collate "C", e.fingerprint`);
  return (r.rows as Record<string, unknown>[]).map((x) => ({
    fingerprint: x.fingerprint as string,
    ruleId: x.rule_id as string,
    url: x.url as string,
    state: x.state as IssueState,
    outcome: (x.outcome as IssueRow["outcome"]) ?? null,
    templateId: (x.template_id as string | null) ?? null,
    message: (x.message as string | null) ?? null,
    verified: x.verify_state === "resolved",
  }));
}

/** One URL of a crawl with its page facts, as the URL explorer lists it. */
export interface UrlRow {
  url: string;
  state: string;
  reason: string | null;
  status: number | null;
  contentType: string | null;
  /** Minimum link depth from a seed (null: only sitemaps found it). */
  depth: number | null;
  /** Clicks from the start URL and distinct pages linking here (site pass). */
  linkDepth: number | null;
  inbound: number | null;
  pagerank: number | null;
  templateId: string | null;
  redirectTarget: string | null;
  discoveredVia: string[];
  elapsedMs: number | null;
  bytes: number | null;
  title: string | null;
  description: string | null;
  h1: string | null;
  wordCount: number | null;
  canonical: string | null;
  /** True when the page's robots meta or X-Robots-Tag says noindex for all crawlers. */
  noindex: boolean;
  /** Open fingerprints (new, persistent, regressed, not_rechecked) on this URL after the verification overlay. */
  openIssues: number;
}

/** Every URL of the crawl in discovery order, or only `only` (a normalised URL). */
export async function urlRows(db: Exec, crawlId: string, only?: string): Promise<UrlRow[]> {
  const one = (col: string) => (only === undefined ? sql`` : sql`and ${sql.raw(col)} = ${only}`);
  const r = await db.execute(sql`with open as (
      select e.url, count(*)::int as n from ${effectiveStates(crawlId)} e where e.state in (${sql.raw(OPEN_STATES.map((x) => `'${x}'`).join(", "))}) ${one("e.url")} group by e.url)
    select u.normalised_url, u.state, u.reason, u.status_code, u.content_type, u.depth, u.link_depth, u.inbound, u.pagerank, u.template_id,
      u.redirect_target, u.discovered_via, u.elapsed_ms, u.bytes, s.title, s.description,
      (select o->>'text' from jsonb_array_elements(s.outline) o where o->>'level' = '1' limit 1) as h1,
      s.word_count,
      (select c->>'resolved' from jsonb_array_elements(s.canonicals) c where c->>'location' <> 'body' limit 1) as canonical,
      coalesce((s.robots->'noindex'->>'meta')::boolean or (s.robots->'noindex'->>'header')::boolean, false) as noindex, coalesce(o.n, 0) as open_issues
    from crawl_urls u left join page_snapshots s on s.url_id = u.id left join open o on o.url = u.normalised_url
    where u.crawl_id = ${crawlId}::uuid ${one("u.normalised_url")} order by u.id`);
  return (r.rows as Record<string, unknown>[]).map((x) => ({
    url: x.normalised_url as string,
    state: x.state as string,
    reason: (x.reason as string | null) ?? null,
    status: x.status_code === null ? null : Number(x.status_code),
    contentType: (x.content_type as string | null) ?? null,
    depth: x.depth === null ? null : Number(x.depth),
    linkDepth: x.link_depth === null ? null : Number(x.link_depth),
    inbound: x.inbound === null ? null : Number(x.inbound),
    pagerank: x.pagerank === null ? null : Number(x.pagerank),
    templateId: (x.template_id as string | null) ?? null,
    redirectTarget: (x.redirect_target as string | null) ?? null,
    discoveredVia: (x.discovered_via as string[]) ?? [],
    elapsedMs: x.elapsed_ms === null ? null : Number(x.elapsed_ms),
    bytes: x.bytes === null ? null : Number(x.bytes),
    title: (x.title as string | null) ?? null,
    description: (x.description as string | null) ?? null,
    h1: (x.h1 as string | null) ?? null,
    wordCount: x.word_count === null ? null : Number(x.word_count),
    canonical: (x.canonical as string | null) ?? null,
    noindex: Boolean(x.noindex),
    openIssues: Number(x.open_issues),
  }));
}

/** A link to or from the inspected URL. */
export interface EdgeRow {
  url: string;
  via: string;
  anchor: string | null;
  rel: string | null;
  location: string | null;
  nofollow: boolean;
  /** The other end is a URL of this crawl (so it can be inspected). */
  inCrawl: boolean;
}

/** One fingerprint on the inspected URL, with its state in each audit of the project that saw it. */
export interface PageIssue {
  fingerprint: string;
  ruleId: string;
  state: IssueState;
  outcome: string | null;
  message: string | null;
  evidence: unknown;
  history: { crawlId: string; createdAt: string; state: IssueState }[];
}

export interface PageDetail {
  url: UrlRow;
  /** The stored page snapshot; null when the URL has none (not fetched, redirect, non-HTML). */
  snapshot: Record<string, unknown> | null;
  linksIn: EdgeRow[];
  linksInTotal: number;
  linksOut: EdgeRow[];
  linksOutTotal: number;
  issues: PageIssue[];
}

/** Edge lists are capped; the totals say how many there are. */
export const EDGE_LIMIT = 500;

/** Everything the crawl knows about one URL (its normalised form); null when the crawl has no such URL. */
export async function pageDetail(db: Exec, crawlId: string, url: string): Promise<PageDetail | null> {
  const [row] = await urlRows(db, crawlId, url);
  if (!row) return null;
  const snap = (
    await db.execute(sql`select s.requested_url, s.final_url, s.status_code, s.content_type, s.redirect_chain, s.headers, s.bytes, s.truncated,
        s.elapsed_ms, s.head, s.canonicals, s.robots, s.titles, s.descriptions, s.outline, s.word_count, s.language, s.links, s.images,
        s.json_ld, s.content_hash, s.text_hash, s.template_fingerprint, s.timings, s.blob_status, s.fetched_at, left(s.main_text, 2000) as main_text_start
      from page_snapshots s join crawl_urls u on u.id = s.url_id where u.crawl_id = ${crawlId}::uuid and u.normalised_url = ${url}`)
  ).rows[0] as Record<string, unknown> | undefined;
  const edges = async (col: "to_url" | "from_url") => {
    const other = col === "to_url" ? sql`from_url` : sql`to_url`;
    const where = col === "to_url" ? sql`to_url = ${url}` : sql`from_url = ${url}`;
    const [list, total] = await Promise.all([
      db.execute(sql`select ${other} as url, via, anchor, rel, location, nofollow,
          exists (select 1 from crawl_urls c where c.crawl_id = ${crawlId}::uuid and c.normalised_url = ${other}) as in_crawl
        from url_edges where crawl_id = ${crawlId}::uuid and ${where} order by id limit ${EDGE_LIMIT}`),
      db.execute(sql`select count(*)::int as n from url_edges where crawl_id = ${crawlId}::uuid and ${where}`),
    ]);
    return {
      rows: (list.rows as Record<string, unknown>[]).map((e) => ({ url: e.url as string, via: e.via as string, anchor: (e.anchor as string | null) ?? null, rel: (e.rel as string | null) ?? null, location: (e.location as string | null) ?? null, nofollow: Boolean(e.nofollow), inCrawl: Boolean(e.in_crawl) })),
      total: Number((total.rows[0] as { n: number }).n),
    };
  };
  const [inb, out] = await Promise.all([edges("to_url"), edges("from_url")]);
  const issues = await db.execute(sql`select e.fingerprint, e.rule_id, e.state, e.outcome,
      f.message, f.evidence,
      coalesce((select jsonb_agg(jsonb_build_object('crawlId', h.crawl_id, 'createdAt', hc.created_at, 'state', h.state) order by hc.created_at, hc.id)
        from issue_states h join crawls hc on hc.id = h.crawl_id join crawls me on me.id = ${crawlId}::uuid
        where h.fingerprint = e.fingerprint and hc.kind = 'audit' and hc.workspace = me.workspace
          and ${projectKey("hc")} = ${projectKey("me")}), '[]'::jsonb) as history
    from ${effectiveStates(crawlId)} e
    left join lateral (select message, evidence from findings f where f.crawl_id = ${crawlId}::uuid and f.fingerprint = e.fingerprint order by f.id limit 1) f on true
    where e.url = ${url} order by e.rule_id collate "C", e.fingerprint`);
  return {
    url: row,
    snapshot: snap ?? null,
    linksIn: inb.rows,
    linksInTotal: inb.total,
    linksOut: out.rows,
    linksOutTotal: out.total,
    issues: (issues.rows as Record<string, unknown>[]).map((x) => ({
      fingerprint: x.fingerprint as string,
      ruleId: x.rule_id as string,
      state: x.state as IssueState,
      outcome: (x.outcome as string | null) ?? null,
      message: (x.message as string | null) ?? null,
      evidence: x.evidence ?? null,
      history: x.history as PageIssue["history"],
    })),
  };
}
