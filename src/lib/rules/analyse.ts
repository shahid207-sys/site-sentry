// The analysis job (docs/SPEC.md "Phase 2" items 4–5): run every registered rule over a finished crawl and store
// the findings. Page rules read full snapshots streamed 500 at a time by id; site rules read a compact per-URL
// projection, also loaded 500 rows at a time. The whole run is one transaction under an advisory lock, so a
// redelivered or concurrent job either waits or replaces the previous result; it never leaves half a result.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { findings as findingsTable } from "../db/schema";
import { normaliseUrl } from "../crawl/normalise";
import { isAllowed, parseRobots } from "../crawl/robots";
import type { SitemapDocRecord } from "../crawl/v2/discovery";
import type { RobotsRecord } from "../crawl/v2/runner";
import type { DiscoverySource, UrlState } from "../crawl/v2/types";
import type { CanonicalTag } from "../snapshot/types";
import { NeedsConfig, type CrawlView, type Finding, type Hreflang, type PageRule, type PageView, type ResourceFacts, type ResourceRule, type Rule, type SiteCtx, type SiteRule, type SiteView, type UrlFacts } from "./contract";
import { bfsDepth, pageRank } from "./graph";
import type { ProbeRecord } from "./probe-types";
import { clusterTemplates, type ShapedPage } from "../snapshot/template";
import { insertOccurrences, occurrenceOf, reachBasis, writeIssueGroups, type Occurrence } from "../results/occurrences";
import { fingerprintOf } from "./fingerprint";
import { TemplateGroups } from "./group";
import { RULES } from "./registry";

export const ANALYSIS_BATCH = 500;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

export interface RuleStat {
  ruleId: string;
  version: number;
  status: "ran" | "needs_config" | "error";
  evaluated: number;
  findings: number;
  totalMs: number;
  detail?: string;
}

export interface AnalysisResult {
  outcome: "analysed" | "not_ready" | "missing";
  pages: number;
  findings: number;
  stats: RuleStat[];
  /** Sum of every rule's time divided by pages evaluated. */
  msPerPage: number;
}

export interface CrawlRow {
  id: string;
  site_origin: string;
  status: string;
  config: { aiCrawlers?: "allow" | "block"; keyPages?: string[] };
  robots: RobotsRecord | null;
  sitemaps: (SitemapDocRecord | { started: string })[];
  probes: ProbeRecord[];
  /** Raw `execute` returns timestamps as strings; Drizzle selects return Dates. */
  started_at: Date | string | null;
  created_at: Date | string;
}

/** First canonical search engines read (head or Link header), normalised like crawled URLs; body canonicals are ignored. */
export function effectiveCanonical(canonicals: CanonicalTag[]): string | null {
  const c = canonicals.find((x) => x.location !== "body" && x.resolved);
  if (!c) return null;
  const n = normaliseUrl(c.resolved!);
  return n.ok ? n.url : c.resolved;
}

/**
 * URL states that mean a URL of the crawled host was never fetched for a reason other than the site's own rules
 * (robots.txt, scope): graph rules cannot prove an absence (no inbound links) when any exists.
 */
const UNFETCHED = ["budget_exhausted", "depth_exceeded", "cancelled", "interrupted", "failed_timeout", "failed_network", "failed_dns", "failed_tls"];

const normalised = (u: string) => {
  const n = normaliseUrl(u);
  return n.ok ? n.url : u;
};

/**
 * The crawl as rules see it. `complete` and `resources` come from the database (analyseCrawl loads them); the
 * defaults (complete when the crawl completed, no resources) are for callers that judge a crawl row alone.
 */
export function crawlView(row: CrawlRow, extra: Partial<Pick<CrawlView, "complete" | "resources">> = {}): CrawlView {
  const parsed = row.robots?.outcome === "parsed" ? parseRobots(row.robots.body ?? "") : null;
  const outcome = row.robots?.outcome;
  return {
    id: row.id,
    origin: row.site_origin,
    startedAt: new Date(row.started_at ?? row.created_at).toISOString(),
    intent: { aiCrawlers: row.config?.aiCrawlers ?? null },
    robots: row.robots,
    robotsAllows: (url, agent) => (parsed ? isAllowed(parsed, agent, url).allowed : outcome === "allow_all" ? true : outcome === "disallow_all" ? false : null),
    sitemaps: (row.sitemaps ?? []).filter((d): d is SitemapDocRecord => "url" in d),
    probes: row.probes ?? [],
    keyPages: row.config?.keyPages?.length ? row.config.keyPages.map(normalised) : null,
    complete: extra.complete ?? row.status === "completed",
    resources: extra.resources ?? { links: new Map(), images: new Map() },
  };
}

async function crawlComplete(db: Exec, crawlId: string, status: string): Promise<boolean> {
  if (status !== "completed") return false;
  const r = await db.execute(sql`select exists (select 1 from crawl_urls where crawl_id = ${crawlId}::uuid and state in (${sql.join(UNFETCHED.map((s) => sql`${s}`), sql`, `)})) as partial`);
  return !(r.rows[0] as { partial: boolean }).partial;
}

async function loadResources(db: Exec, crawlId: string, batch: number): Promise<CrawlView["resources"]> {
  const out: CrawlView["resources"] = { links: new Map(), images: new Map() };
  for (let after = 0; ; ) {
    const r = await db.execute(sql`select id, kind, url, state, skip_code, method, status, content_type, bytes, width, height, error, referrers, sample_pages
      from resources where crawl_id = ${crawlId}::uuid and id > ${after} order by id limit ${batch}`);
    for (const x of r.rows as Record<string, unknown>[]) {
      const f: ResourceFacts = {
        kind: x.kind as ResourceFacts["kind"],
        url: x.url as string,
        // An interrupted row has no answer: rules treat it like one never sent.
        state: x.state === "interrupted" ? "skipped" : (x.state as ResourceFacts["state"]),
        skipCode: x.state === "interrupted" ? "interrupted" : ((x.skip_code as string | null) ?? null),
        method: (x.method as string | null) ?? null,
        status: (x.status as number | null) ?? null,
        contentType: (x.content_type as string | null) ?? null,
        contentLength: x.bytes === null || x.bytes === undefined ? null : Number(x.bytes),
        width: (x.width as number | null) ?? null,
        height: (x.height as number | null) ?? null,
        error: (x.error as ResourceFacts["error"]) ?? null,
        referrers: Number(x.referrers),
        samplePages: (x.sample_pages as string[]) ?? [],
      };
      (f.kind === "external_link" ? out.links : out.images).set(f.url, f);
    }
    if (r.rows.length < batch) break;
    after = Number((r.rows[r.rows.length - 1] as { id: number }).id);
  }
  return out;
}

/**
 * The site pass's link graph (docs/SPEC.md "Phase 2" item 4), written to crawl_urls: inbound (distinct pages with an
 * <a href> to the URL, or to a URL redirecting to it, self-links excluded), click depth from the start page over
 * links and redirects (BFS), and internal PageRank (graph.ts). Edges are streamed `batch` at a time; only integer
 * node ids are kept in memory.
 */
async function linkGraph(db: Exec, crawlId: string, origin: string, batch: number): Promise<void> {
  const index = new Map<string, number>();
  const ids: number[] = [];
  for (let after = 0; ; ) {
    const r = await db.execute(sql`select id, normalised_url from crawl_urls where crawl_id = ${crawlId}::uuid and id > ${after} order by id limit ${batch}`);
    for (const x of r.rows as { id: number; normalised_url: string }[]) {
      index.set(x.normalised_url, ids.length);
      ids.push(Number(x.id));
    }
    if (r.rows.length < batch) break;
    after = ids[ids.length - 1];
  }
  const n = ids.length;
  const adjacency: number[][] = Array.from({ length: n }, () => []);
  const edges: [number, number][] = [];
  for (let after = 0; ; ) {
    const r = await db.execute(sql`select id, from_url, to_url from url_edges where crawl_id = ${crawlId}::uuid and via in ('link', 'redirect') and id > ${after} order by id limit ${batch}`);
    for (const x of r.rows as { id: number; from_url: string; to_url: string }[]) {
      const a = index.get(x.from_url);
      const b = index.get(x.to_url);
      if (a === undefined || b === undefined || a === b) continue;
      adjacency[a].push(b);
      edges.push([a, b]);
    }
    if (r.rows.length < batch) break;
    after = Number((r.rows[r.rows.length - 1] as { id: number }).id);
  }
  const start = index.get(normalised(new URL("/", origin).toString())) ?? -1;
  const depth = bfsDepth(n, adjacency, start);
  const { score } = pageRank(n, edges);
  edges.length = 0;

  // Inbound: counted in the database (distinct source pages), a link to a redirecting URL credited to its target.
  const inbound = new Map<number, number>();
  const r = await db.execute(sql`
    select coalesce(t2.id, t.id) as id, count(distinct e.from_url)::int as n
    from url_edges e
      join crawl_urls t on t.crawl_id = e.crawl_id and t.normalised_url = e.to_url
      left join crawl_urls t2 on t.state = 'redirected' and t2.crawl_id = t.crawl_id and t2.normalised_url = t.redirect_target
    where e.crawl_id = ${crawlId}::uuid and e.via = 'link' and e.from_url <> coalesce(t2.normalised_url, t.normalised_url)
    group by 1`);
  for (const x of r.rows as { id: number; n: number }[]) inbound.set(Number(x.id), x.n);

  for (let i = 0; i < n; i += batch) {
    const rows = ids.slice(i, i + batch).map((id, k) => ({ id, inbound: inbound.get(id) ?? 0, depth: depth[i + k] < 0 ? null : depth[i + k], pr: Math.round(score[i + k] * 100) / 100 }));
    await db.execute(sql`update crawl_urls u set inbound = v.inbound, link_depth = v.depth, pagerank = v.pr
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as v(id bigint, inbound int, depth int, pr real) where u.id = v.id`);
  }
}

/**
 * HTML pages clustered into `templates` by shape (clusterTemplates: exact shapes, then near-identical ones, the URL
 * pattern breaking ties); crawl_urls.template_id is the page's template id, which the rules read as its fingerprint.
 */
async function templates(db: Exec, crawlId: string, batch: number): Promise<void> {
  const pages: ShapedPage[] = [];
  for (let after = 0; ; ) {
    const r = await db.execute(sql`select s.id, u.normalised_url as url, s.template_fingerprint as fingerprint, s.template_shape as shape
      from page_snapshots s join crawl_urls u on u.id = s.url_id
      where s.crawl_id = ${crawlId}::uuid and s.facts is not null and s.template_fingerprint is not null and s.id > ${after} order by s.id limit ${batch}`);
    const rows = r.rows as { id: number; url: string; fingerprint: string; shape: number[] | null }[];
    for (const x of rows) pages.push({ url: x.url, fingerprint: x.fingerprint, shape: x.shape });
    if (rows.length < batch) break;
    after = Number(rows[rows.length - 1].id);
  }
  const ids = clusterTemplates(pages);
  const counts = new Map<string, { n: number; sample: string }>();
  for (const [url, id] of ids) {
    const c = counts.get(id);
    counts.set(id, { n: (c?.n ?? 0) + 1, sample: c && c.sample < url ? c.sample : url });
  }
  await db.execute(sql`delete from templates where crawl_id = ${crawlId}::uuid`);
  await db.execute(sql`update crawl_urls set template_id = null where crawl_id = ${crawlId}::uuid and template_id is not null`);
  const entries = [...counts].map(([fingerprint, c]) => ({ fingerprint, n: c.n, sample: c.sample }));
  for (let i = 0; i < entries.length; i += batch) {
    await db.execute(sql`insert into templates (crawl_id, fingerprint, page_count, sample_url)
      select ${crawlId}::uuid, v.fingerprint, v.n, v.sample from jsonb_to_recordset(${JSON.stringify(entries.slice(i, i + batch))}::jsonb) as v(fingerprint text, n int, sample text)`);
  }
  const assigned = [...ids].map(([url, id]) => ({ url, id }));
  for (let i = 0; i < assigned.length; i += batch) {
    await db.execute(sql`update crawl_urls u set template_id = v.id from jsonb_to_recordset(${JSON.stringify(assigned.slice(i, i + batch))}::jsonb) as v(url text, id text)
      where u.crawl_id = ${crawlId}::uuid and u.normalised_url = v.url`);
  }
}

async function loadSiteView(db: Exec, crawlId: string, batch: number): Promise<SiteView> {
  const urls: UrlFacts[] = [];
  for (let after = 0; ; ) {
    const r = await db.execute(sql`
      select u.id, u.normalised_url, u.state, u.status_code, u.redirect_target, u.discovered_via, u.inbound, u.link_depth, u.pagerank,
        s.facts is not null as html,
        (select coalesce(jsonb_agg(jsonb_build_object('lang', l->>'hreflang', 'href', l->>'href')), '[]'::jsonb) from jsonb_array_elements(s.links) l where l->>'via' = 'hreflang') as hreflang, s.robots, s.canonicals, s.title, s.description, s.text_hash, s.simhash, coalesce(u.template_id, s.template_fingerprint) as template_fingerprint, s.word_count,
        s.facts->'og'->>'image' as og_image, s.facts->'icons' as icons,
        (select e->>'text' from jsonb_array_elements(s.outline) e where e->>'level' = '1' limit 1) as h1
      from crawl_urls u left join page_snapshots s on s.url_id = u.id
      where u.crawl_id = ${crawlId}::uuid and u.id > ${after} order by u.id limit ${batch}`);
    for (const x of r.rows as Record<string, unknown>[]) {
      const robots = x.robots as { noindex: { meta: boolean; header: boolean } } | null;
      urls.push({
        id: Number(x.id),
        url: x.normalised_url as string,
        state: x.state as UrlState,
        statusCode: (x.status_code as number | null) ?? null,
        redirectTarget: (x.redirect_target as string | null) ?? null,
        discoveredVia: x.discovered_via as DiscoverySource[],
        page: x.html
          ? {
              noindex: !!robots && (robots.noindex.meta || robots.noindex.header),
              canonical: effectiveCanonical(x.canonicals as CanonicalTag[]),
              title: (x.title as string | null) ?? null,
              description: (x.description as string | null) ?? null,
              h1: (x.h1 as string | null) ?? null,
              textHash: (x.text_hash as string | null) ?? null,
              simhash: (x.simhash as string | null) ?? null,
              template: (x.template_fingerprint as string | null) ?? null,
              wordCount: (x.word_count as number | null) ?? 0,
              ogImage: (x.og_image as string | null) ?? null,
              icons: (x.icons as string[] | null) ?? [],
              hreflang: (x.hreflang as Hreflang[] | null) ?? [],
            }
          : null,
        inbound: (x.inbound as number | null) ?? 0,
        linkDepth: (x.link_depth as number | null) ?? null,
        pagerank: (x.pagerank as number | null) ?? null,
      });
    }
    if (r.rows.length < batch) break;
    after = urls[urls.length - 1].id;
  }
  return { urls, byUrl: new Map(urls.map((u) => [u.url, u])) };
}

/** For each URL reached through redirects: the hops that led to it, oldest first (lowest-id source at each step). */
export function redirectChains(site: SiteView): Map<number, { url: string; status: number | null }[]> {
  const sources = new Map<string, UrlFacts[]>();
  for (const u of site.urls) {
    if (u.state !== "redirected" || !u.redirectTarget) continue;
    if (!sources.has(u.redirectTarget)) sources.set(u.redirectTarget, []);
    sources.get(u.redirectTarget)!.push(u);
  }
  const out = new Map<number, { url: string; status: number | null }[]>();
  for (const u of site.urls) {
    if (u.state === "redirected" || !sources.has(u.url)) continue;
    const chain: { url: string; status: number | null }[] = [];
    const seen = new Set([u.url]);
    for (let at = u.url; ; ) {
      const prev = sources.get(at)?.find((s) => !seen.has(s.url));
      if (!prev) break;
      seen.add(prev.url);
      chain.unshift({ url: prev.url, status: prev.statusCode });
      at = prev.url;
    }
    if (chain.length) out.set(u.id, chain);
  }
  return out;
}

function pageView(x: Record<string, unknown>): PageView {
  const timings = (x.timings as { fetchMs: number; extractMs: number } | null) ?? { fetchMs: x.elapsed_ms as number, extractMs: 0 };
  return {
    urlId: Number(x.url_id),
    url: x.normalised_url as string,
    state: x.state as UrlState,
    depth: (x.depth as number | null) ?? null,
    discoveredVia: x.discovered_via as DiscoverySource[],
    html: x.facts !== null,
    requestedUrl: (x.requested_url as string | null) ?? (x.normalised_url as string),
    finalUrl: x.final_url as string,
    statusCode: x.status_code as number,
    contentType: x.content_type as string,
    redirectChain: x.redirect_chain as PageView["redirectChain"],
    headers: x.headers as Record<string, string>,
    rawHtmlKey: (x.raw_html_key as string | null) ?? null,
    bytes: x.bytes as number,
    truncated: x.truncated as boolean,
    head: x.head as PageView["head"],
    canonicals: x.canonicals as PageView["canonicals"],
    robots: x.robots as PageView["robots"],
    titles: x.titles as string[],
    descriptions: x.descriptions as string[],
    outline: x.outline as PageView["outline"],
    mainText: (x.main_text as string | null) ?? "",
    wordCount: (x.word_count as number | null) ?? 0,
    language: x.language as PageView["language"],
    links: x.links as PageView["links"],
    images: x.images as PageView["images"],
    jsonLd: x.json_ld as PageView["jsonLd"],
    contentHash: (x.content_hash as string | null) ?? null,
    textHash: (x.text_hash as string | null) ?? null,
    simhash: (x.simhash as string | null) ?? null,
    templateFingerprint: (x.template_fingerprint as string | null) ?? null,
    timings,
    facts: x.facts as PageView["facts"],
  };
}

class Stats {
  private readonly m = new Map<string, RuleStat>();
  constructor(rules: Rule[]) {
    for (const r of rules) this.m.set(r.id, { ruleId: r.id, version: r.version, status: "ran", evaluated: 0, findings: 0, totalMs: 0 });
  }
  run<C>(rule: { id: string; evaluate(ctx: C): Finding[] }, ctx: C, out: Finding[]): void {
    const s = this.m.get(rule.id)!;
    if (s.status !== "ran") return;
    const t = performance.now();
    try {
      const f = rule.evaluate(ctx);
      s.findings += f.length;
      out.push(...f);
    } catch (e) {
      if (e instanceof NeedsConfig) {
        s.status = "needs_config";
        s.detail = e.message;
      } else {
        s.status = "error";
        s.detail = (e as Error)?.message ?? String(e);
      }
    } finally {
      s.totalMs += performance.now() - t;
      s.evaluated++;
    }
  }
  /** Corrects a rule's finding count (grouped rules store one finding per group, not one per page). */
  adjust(ruleId: string, delta: number): void {
    this.m.get(ruleId)!.findings += delta;
  }
  all(): RuleStat[] {
    return [...this.m.values()].map((s) => ({ ...s, totalMs: Math.round(s.totalMs * 1000) / 1000 }));
  }
}

async function insertFindings(tx: Exec, crawlId: string, list: Finding[], byId: Map<string, Rule>): Promise<void> {
  for (let i = 0; i < list.length; i += 500) {
    await tx.insert(findingsTable).values(
      list.slice(i, i + 500).map((f) => {
        const { fingerprint, key } = fingerprintOf(byId.get(f.ruleId), f);
        return { crawlId, ruleId: f.ruleId, ruleVersion: f.ruleVersion, url: f.url, confidence: f.confidence, outcome: f.outcome, message: f.message, evidence: f.evidence, fingerprint, evidenceKey: key };
      }),
    );
  }
}

export async function analyseCrawl(db: Db, crawlId: string, opts: { rules?: Rule[]; batchSize?: number; log?: (e: string, d?: Record<string, unknown>) => void } = {}): Promise<AnalysisResult> {
  const rules = opts.rules ?? RULES;
  const batch = opts.batchSize ?? ANALYSIS_BATCH;
  const log = opts.log ?? (() => {});
  const empty = (outcome: AnalysisResult["outcome"]): AnalysisResult => ({ outcome, pages: 0, findings: 0, stats: [], msPerPage: 0 });

  const r0 = await db.execute(sql`select id, site_origin, status, config, robots, sitemaps, probes, started_at, created_at from crawls where id = ${crawlId}::uuid`);
  const row = r0.rows[0] as unknown as CrawlRow | undefined;
  if (!row) return empty("missing");
  if (row.status !== "completed" && row.status !== "cancelled") return empty("not_ready");
  const startedAt = new Date().toISOString();
  await db.execute(sql`update crawls set analysis = ${JSON.stringify({ status: "running", startedAt })}::jsonb where id = ${crawlId}::uuid`);

  try {
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`analysis:${crawlId}`}, 0))`);
      await tx.execute(sql`delete from findings where crawl_id = ${crawlId}::uuid`);
      await tx.execute(sql`delete from rule_runs where crawl_id = ${crawlId}::uuid`);
      await tx.execute(sql`delete from finding_occurrences where crawl_id = ${crawlId}::uuid`);
      await tx.execute(sql`delete from issue_groups where crawl_id = ${crawlId}::uuid`);
      await tx.execute(sql`delete from issue_group_templates where crawl_id = ${crawlId}::uuid`);
      for (const r of rules) {
        await tx.execute(sql`insert into rules (id, version, category, scope, confidence, impact, updated_at) values (${r.id}, ${r.version}, ${r.category}, ${r.scope}, ${r.confidence}, ${r.impact}, now())
          on conflict (id) do update set version = excluded.version, category = excluded.category, scope = excluded.scope, confidence = excluded.confidence, impact = excluded.impact, updated_at = now()`);
      }
      await linkGraph(tx, crawlId, row.site_origin, batch);
      await templates(tx, crawlId, batch);
      const crawl = crawlView(row, { complete: await crawlComplete(tx, crawlId, row.status), resources: await loadResources(tx, crawlId, batch) });
      const site = await loadSiteView(tx, crawlId, batch);
      const basis = reachBasis(site);
      const byId = new Map(rules.map((r) => [r.id, r] as [string, Rule]));
      let duplicates = 0;

      // Redirect chains are a snapshot field, filled here from the redirect rows before rules read them.
      const chains = [...redirectChains(site)].map(([urlId, chain]) => ({ url_id: urlId, chain }));
      for (let i = 0; i < chains.length; i += batch) {
        await tx.execute(sql`update page_snapshots s set redirect_chain = v.chain
          from jsonb_to_recordset(${JSON.stringify(chains.slice(i, i + batch))}::jsonb) as v(url_id bigint, chain jsonb) where s.url_id = v.url_id`);
      }

      const stats = new Stats(rules);
      const pageRules = rules.filter((r): r is PageRule => r.scope === "page");
      const siteRules = rules.filter((r): r is SiteRule => r.scope === "site");
      const resourceRules = rules.filter((r): r is ResourceRule => r.scope === "resource");
      // Page-rule issues per rule and template, for SITE-001 (one finding for a defect a whole template shares).
      const pageIssues: SiteCtx["pageIssues"] = new Map();
      // Rules that report per template group: one bounded entry per group, emitted after the last page.
      const grouped = new TemplateGroups();
      let pages = 0;
      let total = 0;
      for (let after = 0; ; ) {
        const r = await tx.execute(sql`select s.*, coalesce(u.template_id, s.template_fingerprint) as template_fingerprint, u.normalised_url, u.state, u.depth, u.discovered_via from page_snapshots s join crawl_urls u on u.id = s.url_id
          where s.crawl_id = ${crawlId}::uuid and s.id > ${after} order by s.id limit ${batch}`);
        const found: Finding[] = [];
        // Every page's own findings, grouped rules included: issue groups, reach and states count pages.
        const occurrences: Occurrence[] = [];
        for (const x of r.rows as Record<string, unknown>[]) {
          const page = pageView(x);
          pages++;
          for (const rule of pageRules) {
            const own: Finding[] = [];
            stats.run(rule, { page, crawl, site }, own);
            for (const f of own) occurrences.push(occurrenceOf(rule, f, basis));
            if (rule.groupByTemplate) {
              const ungrouped = grouped.add(own, page.templateFingerprint);
              stats.adjust(rule.id, ungrouped.length - own.length); // grouped issues are counted once per group, below
              found.push(...ungrouped);
            } else found.push(...own);
            if (!page.templateFingerprint || !own.some((f) => f.outcome === "issue")) continue;
            if (!pageIssues.has(rule.id)) pageIssues.set(rule.id, new Map());
            const t = pageIssues.get(rule.id)!.get(page.templateFingerprint) ?? { count: 0, sample: [] };
            t.count++;
            if (t.sample.length < 5) t.sample.push(page.url);
            pageIssues.get(rule.id)!.set(page.templateFingerprint, t);
          }
        }
        await insertFindings(tx, crawlId, found, byId);
        duplicates += await insertOccurrences(tx, crawlId, occurrences, batch);
        total += found.length;
        if (r.rows.length < batch) break;
        after = Number((r.rows[r.rows.length - 1] as { id: number }).id);
      }
      const siteFound: Finding[] = grouped.findings();
      const groupedCount = siteFound.length; // their occurrences are the pages', stored above
      for (const f of siteFound) stats.adjust(f.ruleId, 1);
      for (const rule of siteRules) stats.run(rule, { site, crawl, pageIssues }, siteFound);
      for (const rule of resourceRules) {
        for (const resource of (rule.kind === "image" ? crawl.resources.images : crawl.resources.links).values()) stats.run(rule, { resource, crawl }, siteFound);
      }
      await insertFindings(tx, crawlId, siteFound, byId);
      duplicates += await insertOccurrences(
        tx,
        crawlId,
        siteFound.slice(groupedCount).map((f) => occurrenceOf(byId.get(f.ruleId), f, basis)),
        batch,
      );
      total += siteFound.length;
      if (duplicates) log("analysis.duplicate_fingerprints", { crawlId, duplicates });
      const issueGroups = await writeIssueGroups(tx, crawlId, rules, basis.indexable);

      const list = stats.all();
      for (const s of list) {
        await tx.execute(sql`insert into rule_runs (crawl_id, rule_id, rule_version, status, evaluated, findings, total_ms, detail)
          values (${crawlId}::uuid, ${s.ruleId}, ${s.version}, ${s.status}, ${s.evaluated}, ${s.findings}, ${s.totalMs}, ${s.detail ?? null})`);
      }
      // fetched → analysed: every snapshot was read by the page rules above.
      await tx.execute(sql`update crawl_urls set state = 'analysed', updated_at = now() where crawl_id = ${crawlId}::uuid and state = 'fetched'`);
      const msPerPage = pages ? Math.round((list.reduce((n, s) => n + s.totalMs, 0) / pages) * 1000) / 1000 : 0;
      await tx.execute(sql`update crawls set analysis = ${JSON.stringify({ status: "completed", startedAt, finishedAt: new Date().toISOString(), pages, findings: total, msPerPage, issueGroups, duplicateFingerprints: duplicates })}::jsonb where id = ${crawlId}::uuid`);
      return { outcome: "analysed" as const, pages, findings: total, stats: list, msPerPage };
    });
    log("analysis.completed", { crawlId, pages: result.pages, findings: result.findings, msPerPage: result.msPerPage });
    return result;
  } catch (e) {
    const error = (e as Error)?.message ?? String(e);
    await db.execute(sql`update crawls set analysis = ${JSON.stringify({ status: "failed", startedAt, error, at: new Date().toISOString() })}::jsonb where id = ${crawlId}::uuid`);
    log("analysis.failed", { crawlId, error });
    throw e;
  }
}
