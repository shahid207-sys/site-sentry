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
import { NeedsConfig, type CrawlView, type Finding, type PageRule, type PageView, type Rule, type SiteRule, type SiteView, type UrlFacts } from "./contract";
import type { ProbeRecord } from "./probe-types";
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
  config: { aiCrawlers?: "allow" | "block" };
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

export function crawlView(row: CrawlRow): CrawlView {
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
  };
}

async function loadSiteView(db: Exec, crawlId: string, batch: number): Promise<SiteView> {
  const urls: UrlFacts[] = [];
  for (let after = 0; ; ) {
    const r = await db.execute(sql`
      select u.id, u.normalised_url, u.state, u.status_code, u.redirect_target, u.discovered_via,
        s.facts is not null as html, s.robots, s.canonicals, s.title, s.description, s.text_hash, s.simhash, s.template_fingerprint, s.word_count,
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
            }
          : null,
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
  all(): RuleStat[] {
    return [...this.m.values()].map((s) => ({ ...s, totalMs: Math.round(s.totalMs * 1000) / 1000 }));
  }
}

async function insertFindings(tx: Exec, crawlId: string, list: Finding[]): Promise<void> {
  for (let i = 0; i < list.length; i += 500) {
    await tx.insert(findingsTable).values(
      list.slice(i, i + 500).map((f) => ({ crawlId, ruleId: f.ruleId, ruleVersion: f.ruleVersion, url: f.url, confidence: f.confidence, message: f.message, evidence: f.evidence })),
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
      for (const r of rules) {
        await tx.execute(sql`insert into rules (id, version, category, scope, confidence, impact, updated_at) values (${r.id}, ${r.version}, ${r.category}, ${r.scope}, ${r.confidence}, ${r.impact}, now())
          on conflict (id) do update set version = excluded.version, category = excluded.category, scope = excluded.scope, confidence = excluded.confidence, impact = excluded.impact, updated_at = now()`);
      }
      const crawl = crawlView(row);
      const site = await loadSiteView(tx, crawlId, batch);

      // Redirect chains are a snapshot field, filled here from the redirect rows before rules read them.
      const chains = [...redirectChains(site)].map(([urlId, chain]) => ({ url_id: urlId, chain }));
      for (let i = 0; i < chains.length; i += batch) {
        await tx.execute(sql`update page_snapshots s set redirect_chain = v.chain
          from jsonb_to_recordset(${JSON.stringify(chains.slice(i, i + batch))}::jsonb) as v(url_id bigint, chain jsonb) where s.url_id = v.url_id`);
      }

      const stats = new Stats(rules);
      const pageRules = rules.filter((r): r is PageRule => r.scope === "page");
      const siteRules = rules.filter((r): r is SiteRule => r.scope === "site");
      let pages = 0;
      let total = 0;
      for (let after = 0; ; ) {
        const r = await tx.execute(sql`select s.*, u.normalised_url, u.state, u.depth, u.discovered_via from page_snapshots s join crawl_urls u on u.id = s.url_id
          where s.crawl_id = ${crawlId}::uuid and s.id > ${after} order by s.id limit ${batch}`);
        const found: Finding[] = [];
        for (const x of r.rows as Record<string, unknown>[]) {
          const page = pageView(x);
          pages++;
          for (const rule of pageRules) stats.run(rule, { page, crawl }, found);
        }
        await insertFindings(tx, crawlId, found);
        total += found.length;
        if (r.rows.length < batch) break;
        after = Number((r.rows[r.rows.length - 1] as { id: number }).id);
      }
      const siteFound: Finding[] = [];
      for (const rule of siteRules) stats.run(rule, { site, crawl }, siteFound);
      await insertFindings(tx, crawlId, siteFound);
      total += siteFound.length;

      const list = stats.all();
      for (const s of list) {
        await tx.execute(sql`insert into rule_runs (crawl_id, rule_id, rule_version, status, evaluated, findings, total_ms, detail)
          values (${crawlId}::uuid, ${s.ruleId}, ${s.version}, ${s.status}, ${s.evaluated}, ${s.findings}, ${s.totalMs}, ${s.detail ?? null})`);
      }
      // fetched → analysed: every snapshot was read by the page rules above.
      await tx.execute(sql`update crawl_urls set state = 'analysed', updated_at = now() where crawl_id = ${crawlId}::uuid and state = 'fetched'`);
      const msPerPage = pages ? Math.round((list.reduce((n, s) => n + s.totalMs, 0) / pages) * 1000) / 1000 : 0;
      await tx.execute(sql`update crawls set analysis = ${JSON.stringify({ status: "completed", startedAt, finishedAt: new Date().toISOString(), pages, findings: total, msPerPage })}::jsonb where id = ${crawlId}::uuid`);
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
