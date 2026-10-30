// The render phase of a crawl (docs/SPEC.md Phase 5): after the crawl ends and before analysis, render its HTML pages
// in the render pool, store the rendered DOM and what rules need from it (page_renders), then hand the crawl to
// analysis. Render modes (crawls.config.render): off (the default, and every crawl from before Phase 5), sampled (one
// page per template plus the start URL), full (every HTML page).
//
// The job is idempotent and resumable: a page with a page_renders row is not rendered again, and crawls.render
// records progress. Analysis waits while a crawl that asks for rendering has not finished it (awaitingRender).
import { sql } from "drizzle-orm";
import { parseHtml } from "../audit/parse";
import { isAllowed, parseRobots } from "../crawl/robots";
import { extractOutlinks } from "../crawl/v2/discovery";
import type { HostThrottle } from "../crawl/v2/politeness";
import { ROBOTS_TOKEN, type RobotsRecord } from "../crawl/v2/runner";
import type { Db } from "../db/client";
import { getRawHtml, putRenderedHtml, type BlobStore } from "../snapshot/blob-store";
import { extractHtml } from "../snapshot/extract";
import type { CanonicalTag, HeadingEntry, RobotsSnapshot } from "../snapshot/types";
import type { RenderGate, RenderPool, RenderResult } from "./pool";

type Exec = Pick<Db, "execute">;

export const RENDER_MODES = ["off", "sampled", "full"] as const;
export type RenderMode = (typeof RENDER_MODES)[number];

/** Links found only in the rendered DOM, kept as evidence (they are not crawled: see docs/PHASE5.md). */
export const MAX_RENDERED_LINKS = 50;

/** A crawl's render mode. Unset (crawls from before Phase 5) and fix verifications are off. */
export function renderModeOf(config: { render?: unknown; verify?: unknown } | null | undefined): RenderMode {
  if (!config || config.verify) return "off";
  return RENDER_MODES.includes(config.render as RenderMode) ? (config.render as RenderMode) : "off";
}

export interface RenderProgress {
  mode: Exclude<RenderMode, "off">;
  status: "running" | "done" | "failed";
  /** Pages the mode selects, rendered or not yet. */
  planned: number;
  rendered: number;
  timeouts: number;
  errors: number;
  startedAt: string;
  finishedAt?: string;
  /** Why the whole phase failed (the browser could not start, for instance). */
  error?: string;
}

/** What rules compare between the raw snapshot and the rendered DOM. */
export interface RenderedExtract {
  canonicals: CanonicalTag[];
  robots: RobotsSnapshot;
  titles: string[];
  outline: HeadingEntry[];
  wordCount: number;
  textHash: string | null;
  jsonLdBlocks: number;
  images: number;
  /** <a href> links in the rendered DOM, and those the raw HTML did not have (normalised URLs). */
  links: { total: number; renderedOnly: string[]; renderedOnlyCount: number; rawOnlyCount: number };
}

/** SQL predicate on crawl alias `c`: the crawl asks for rendering and has not finished it. */
export const awaitingRender = (c: string) =>
  sql.raw(`(${c}.kind = 'audit' and ${c}.config->>'render' in ('sampled', 'full') and coalesce(${c}.render->>'status', 'pending') not in ('done', 'failed'))`);

/** Ended crawls whose render phase is still to do (boot reconcile). */
export async function unrenderedCrawls(db: Exec): Promise<string[]> {
  const r = await db.execute(sql`select c.id from crawls c where c.status in ('completed', 'cancelled') and ${awaitingRender("c")} order by c.finished_at nulls last`);
  return (r.rows as { id: string }[]).map((x) => x.id);
}

export interface PlannedRender {
  urlId: number;
  url: string;
  rawHtmlKey: string;
  headers: Record<string, string>;
  rawLinks: { href: string; via: string }[];
}

/**
 * The pages mode `mode` renders: HTML 200 pages whose raw HTML is stored. Sampled: per template fingerprint, the
 * page with the shortest URL (then the first in code-point order), plus the start URL (depth 0) if it is one of them.
 */
export async function planRenders(db: Exec, crawlId: string, mode: Exclude<RenderMode, "off">): Promise<PlannedRender[]> {
  const pages = sql`select s.url_id, s.final_url, s.raw_html_key, s.headers, s.template_fingerprint, u.normalised_url, u.depth from page_snapshots s join crawl_urls u on u.id = s.url_id
    where s.crawl_id = ${crawlId}::uuid and s.status_code = 200 and s.facts is not null and s.raw_html_key is not null and s.blob_status = 'stored'`;
  const chosen =
    mode === "full"
      ? sql`select * from (${pages}) p`
      : sql`select * from (${pages}) p where p.depth = 0 or p.url_id in (
          select distinct on (coalesce(q.template_fingerprint, q.normalised_url)) q.url_id from (${pages}) q
          order by coalesce(q.template_fingerprint, q.normalised_url), length(q.normalised_url), q.normalised_url collate "C")`;
  const r = await db.execute(sql`select c.url_id, c.final_url, c.raw_html_key, c.headers, (select s.links from page_snapshots s where s.url_id = c.url_id) as links
    from (${chosen}) c order by c.depth nulls last, length(c.normalised_url), c.normalised_url collate "C"`);
  return (r.rows as { url_id: number; final_url: string; raw_html_key: string; headers: Record<string, string>; links: { href: string; via: string }[] }[]).map((x) => ({
    urlId: Number(x.url_id),
    url: x.final_url,
    rawHtmlKey: x.raw_html_key,
    headers: x.headers,
    rawLinks: x.links ?? [],
  }));
}

/** The facts rules read from a rendered DOM. `rawLinks`: the raw snapshot's links, to tell rendered-only links apart. */
export function extractRendered(html: string, pageUrl: string, headers: Record<string, string>, rawLinks: { href: string; via: string }[]): RenderedExtract {
  const $ = parseHtml(html);
  const out = extractOutlinks($, pageUrl);
  const ex = extractHtml({ $, html, pageUrl, headers, bytes: Buffer.byteLength(html), outlinks: out.links });
  const anchors = (xs: { href: string; via: string }[]) => new Set(xs.filter((l) => l.via === "link").map((l) => l.href)); // <a href>, <area href>
  const raw = anchors(rawLinks);
  const rendered = anchors(ex.links);
  const renderedOnly = [...rendered].filter((u) => !raw.has(u)).sort();
  return {
    canonicals: ex.canonicals,
    robots: ex.robots,
    titles: ex.titles,
    outline: ex.outline.slice(0, 50),
    wordCount: ex.wordCount,
    textHash: ex.textHash,
    jsonLdBlocks: ex.jsonLd.length,
    images: ex.images.length,
    links: { total: rendered.size, renderedOnly: renderedOnly.slice(0, MAX_RENDERED_LINKS), renderedOnlyCount: renderedOnly.length, rawOnlyCount: [...raw].filter((u) => !rendered.has(u)).length },
  };
}

/**
 * The gate for a crawl's renders: requests to the crawl's own host follow its robots.txt (as Googlebot's renderer
 * does: IDX-026 is the finding when that hides CSS or JS) and share the host's politeness throttle with the crawler.
 * Requests to other hosts (CDNs, third parties) pass.
 */
export function crawlGate(origin: string, robots: RobotsRecord | null, throttle?: HostThrottle): RenderGate {
  const host = new URL(origin).host;
  const parsed = robots?.outcome === "parsed" ? parseRobots(robots.body ?? "") : null;
  return async (url, signal) => {
    if (url.host !== host) return { ok: true, done: async () => {} };
    const allowed = parsed ? isAllowed(parsed, ROBOTS_TOKEN, url.toString()).allowed : robots?.outcome !== "disallow_all";
    if (!allowed) return { ok: false, reason: "robots" };
    if (!throttle) return { ok: true, done: async () => {} };
    const slot = await throttle.acquire(signal);
    return { ok: true, done: (o) => throttle.release(slot, o) };
  };
}

export interface RenderRunOptions {
  db: Db;
  pool: RenderPool;
  store: BlobStore;
  /** The gate for this crawl's requests (crawlGate). Without one, requests are not throttled and robots.txt is not read. */
  gate?: (crawl: { origin: string; robots: RobotsRecord | null }) => RenderGate;
  signal?: AbortSignal;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

export type RenderOutcome = "done" | "skipped" | "not_ready" | "missing" | "stopped";

async function writeProgress(db: Exec, crawlId: string, p: RenderProgress): Promise<void> {
  await db.execute(sql`update crawls set render = ${JSON.stringify(p)}::jsonb where id = ${crawlId}::uuid`);
}

/** Records that the render phase of crawl `crawlId` failed as a whole; analysis then runs without renders. */
export async function markRenderFailed(db: Exec, crawlId: string, error: string): Promise<void> {
  await db.execute(sql`update crawls set render = coalesce(render, jsonb_build_object('mode', config->>'render', 'planned', 0, 'rendered', 0, 'timeouts', 0, 'errors', 0, 'startedAt', now()))
    || jsonb_build_object('status', 'failed', 'error', ${error.slice(0, 500)}::text, 'finishedAt', now()) where id = ${crawlId}::uuid`);
}

/** Render crawl `crawlId`'s pages for its render mode. Returns "stopped" when `signal` aborts (the job runs again). */
export async function renderCrawl(opts: RenderRunOptions, crawlId: string): Promise<RenderOutcome> {
  const { db, pool, store } = opts;
  const log = opts.log ?? (() => {});
  const r = await db.execute(sql`select id, kind, status, config, site_origin, robots, render from crawls where id = ${crawlId}::uuid`);
  const row = r.rows[0] as { kind: string; status: string; config: { render?: unknown; verify?: unknown }; site_origin: string; robots: RobotsRecord | null; render: RenderProgress | null } | undefined;
  if (!row) return "missing";
  if (row.status !== "completed" && row.status !== "cancelled") return "not_ready";
  const mode = row.kind === "audit" ? renderModeOf(row.config) : "off";
  if (mode === "off") return "skipped";
  if (row.render?.status === "done" || row.render?.status === "failed") return "done";

  const plan = await planRenders(db, crawlId, mode);
  const done = (await db.execute(sql`select status, count(*)::int as n from page_renders where crawl_id = ${crawlId}::uuid group by status`)).rows as { status: string; n: number }[];
  const count = (s: string) => done.find((x) => x.status === s)?.n ?? 0;
  const already = new Set(((await db.execute(sql`select url_id from page_renders where crawl_id = ${crawlId}::uuid`)).rows as { url_id: number }[]).map((x) => Number(x.url_id)));
  const todo = plan.filter((p) => !already.has(p.urlId));
  const progress: RenderProgress = {
    mode,
    status: "running",
    planned: plan.length + [...already].filter((id) => !plan.some((p) => p.urlId === id)).length,
    rendered: count("rendered"),
    timeouts: count("timeout"),
    errors: count("error"),
    startedAt: row.render?.startedAt ?? new Date().toISOString(),
  };
  await writeProgress(db, crawlId, progress);
  log("render.start", { crawlId, mode, planned: progress.planned, todo: todo.length });
  const gate = opts.gate?.({ origin: row.site_origin, robots: row.robots });

  // One page per browser at a time; progress is written every 10 pages.
  let next = 0;
  let sinceWrite = 0;
  const one = async (p: PlannedRender) => {
    const html = await getRawHtml(store, p.rawHtmlKey);
    const res: RenderResult =
      html === null
        ? { status: "error", error: "The raw HTML is missing from storage.", url: p.url, finalUrl: p.url, html: null, elapsedMs: 0, metrics: null, requests: [], requestTotals: { count: 0, fulfilled: 0, blocked: 0, failed: 0, logged: 0 }, scriptNavigations: [], scriptLinks: null, a11y: null, consoleErrors: 0 }
        : await pool.render({ url: p.url, html, signal: opts.signal, gate });
    // A render cut short by shutdown is not a result: the page is rendered again when the job resumes.
    if (opts.signal?.aborted) return;
    let key: string | null = null;
    let extract: RenderedExtract | null = null;
    if (res.status === "rendered" && res.html !== null) {
      key = await putRenderedHtml(store, crawlId, p.urlId, res.html);
      extract = extractRendered(res.html, p.url, p.headers, p.rawLinks);
    }
    await db.execute(sql`insert into page_renders (crawl_id, url_id, url, final_url, status, error, rendered_html_key, elapsed_ms, metrics, extract, requests, request_totals, script_links, script_navigations, a11y, console_errors)
      values (${crawlId}::uuid, ${p.urlId}, ${p.url}, ${res.finalUrl}, ${res.status}, ${res.error ?? null}, ${key}, ${res.elapsedMs}, ${json(res.metrics)}::jsonb, ${json(extract)}::jsonb,
        ${JSON.stringify(res.requests)}::jsonb, ${JSON.stringify(res.requestTotals)}::jsonb, ${json(res.scriptLinks)}::jsonb, ${JSON.stringify(res.scriptNavigations)}::jsonb, ${json(res.a11y)}::jsonb, ${res.consoleErrors})
      on conflict (url_id) do nothing`);
    if (res.status === "rendered") progress.rendered++;
    else if (res.status === "timeout") progress.timeouts++;
    else progress.errors++;
    if (++sinceWrite >= 10) {
      sinceWrite = 0;
      await writeProgress(db, crawlId, progress);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(pool.size, todo.length) }, async () => {
      while (next < todo.length && !opts.signal?.aborted) await one(todo[next++]);
    }),
  );
  if (opts.signal?.aborted) {
    await writeProgress(db, crawlId, progress);
    return "stopped";
  }
  progress.status = "done";
  progress.finishedAt = new Date().toISOString();
  await writeProgress(db, crawlId, progress);
  log("render.end", { crawlId, ...progress });
  return "done";
}

const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
