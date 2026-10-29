// Resource phase (docs/SPEC.md "Phase 2"; LNK-010 and IMG-004..010): after the URL crawl and its probes, check the
// external links and the images the crawled pages reference, and store the results in `resources`.
//
// - Budgets: at most MAX_EXTERNAL_LINKS unique external link URLs and MAX_IMAGE_URLS unique image URLs per crawl. External
//   links are picked round-robin across hosts (one site linking 2,000 times to one domain cannot use the whole
//   budget); images in first-seen order. What is over budget is counted in the crawl's summary, not requested.
// - Every request goes through the crawl's fetcher (SSRF guards on every hop) inside the target host's throttle (the
//   same Redis politeness as crawled URLs), and obeys that host's robots.txt, read once per host. None is charged to
//   the URL budget (fetches_committed).
// - External links: HEAD, and GET only when the server refuses HEAD (safe-fetch retries 403/405/501 with GET).
//   Redirects are followed. Images: HEAD for type and size; for raster images, then a GET of the first
//   MAX_IMAGE_HEAD_BYTES with a Range header, for the intrinsic size (and the total size from Content-Range).
// - At most once: a row is marked started just before its first request. A resumed crawl marks a started row
//   interrupted and never re-sends it; queued rows are sent.
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { MAX_IMAGE_HEAD_BYTES, SafeFetchError, type FetchOptions, type FetchResult } from "../../fetch/safe-fetch";
import { imageSize } from "../../snapshot/image-size";
import type { SnapshotImage, SnapshotLink } from "../../snapshot/types";
import { isAllowed, parseRobots } from "../robots";
import type { HostThrottle } from "./politeness";

export const MAX_EXTERNAL_LINKS = 500;
export const MAX_IMAGE_URLS = 2000;
/** Pages kept per resource as evidence (the count is complete). */
export const SAMPLE_PAGES = 5;
/** Hosts checked at the same time; each host still gets its own throttle. */
export const HOST_LANES = 6;
/** Distinct URLs tracked per kind while planning; past this, URLs are only counted (memory bound on huge sites). */
const TRACK_CAP = 50_000;
const BATCH = 500;

export type ResourceKind = "external_link" | "image";

export interface ResourceKindSummary {
  /** Distinct URLs referenced by crawled pages (counted up to the tracking cap, then `found` stops growing). */
  found: number;
  /** Rows created (≤ budget). */
  planned: number;
  overBudget: number;
  budget: number;
}

/** crawls.resources */
export interface CrawlResourcesSummary {
  /** When the URL crawl (and probes) ended and this phase began. */
  urlPhaseFinishedAt: string;
  planned: boolean;
  external: ResourceKindSummary;
  images: ResourceKindSummary;
  finishedAt?: string;
}

export interface ResourceContext {
  db: Db;
  crawlId: string;
  /** The crawled site's origin: links to its hostname are internal, not external. */
  origin: string;
  /** Summary stored by an earlier run of this crawl, if any. */
  existing: CrawlResourcesSummary | null;
  /** The throttle for a host (host:port); the crawl's own host gets the crawl's throttle. */
  throttle(host: string): HostThrottle;
  /** Send a request in a slot already held on `throttle`; the slot is released (with the outcome) when it returns. */
  send(url: string, o: Omit<FetchOptions, "signal" | "timeoutMs" | "userAgent">, throttle: HostThrottle, slot: string): Promise<FetchResult>;
  /** Why the crawl's own robots.txt forbids this URL on the crawled host, or null. */
  robotsBlockedOwn(url: string): string | null;
  robotsToken: string;
  /** Aborted when the crawl is stopping (pause, cancel, shutdown): queued rows stay for the resumed run. */
  signal: AbortSignal;
  log(event: string, data?: Record<string, unknown>): void;
  limits?: { externalLinks?: number; images?: number };
}

interface Row {
  id: number;
  kind: ResourceKind;
  url: string;
  host: string;
}

const isHttp = (u: string | null | undefined): u is string => !!u && /^https?:\/\//i.test(u);

/** First-seen order, referrer counts and sample pages for one kind. */
class Tally {
  readonly urls = new Map<string, { referrers: number; pages: string[] }>();
  found = 0;
  add(url: string, page: string) {
    const t = this.urls.get(url);
    if (t) {
      t.referrers++;
      if (t.pages.length < SAMPLE_PAGES) t.pages.push(page);
      return;
    }
    this.found++;
    if (this.urls.size < TRACK_CAP) this.urls.set(url, { referrers: 1, pages: [page] });
  }
}

/** External <a href> targets and image URLs of every HTML snapshot, in crawl order, without loading all snapshots. */
async function collect(ctx: ResourceContext): Promise<{ links: Tally; images: Tally }> {
  const own = new URL(ctx.origin).hostname;
  const links = new Tally();
  const images = new Tally();
  for (let after = 0; ; ) {
    const r = await ctx.db.execute(sql`select s.id, u.normalised_url as page, s.links, s.images from page_snapshots s join crawl_urls u on u.id = s.url_id
      where s.crawl_id = ${ctx.crawlId}::uuid and s.facts is not null and s.id > ${after} order by s.id limit ${BATCH}`);
    for (const row of r.rows as { id: number; page: string; links: SnapshotLink[] | null; images: SnapshotImage[] | null }[]) {
      const seen = new Set<string>();
      for (const l of row.links ?? []) {
        if (l.via !== "link" || !isHttp(l.href) || seen.has(l.href)) continue;
        if (new URL(l.href).hostname === own) continue;
        seen.add(l.href);
        links.add(l.href, row.page);
      }
      const seenImg = new Set<string>();
      for (const i of row.images ?? []) {
        if (!isHttp(i.resolved) || seenImg.has(i.resolved)) continue;
        seenImg.add(i.resolved);
        images.add(i.resolved, row.page);
      }
    }
    if (r.rows.length < BATCH) break;
    after = Number((r.rows[r.rows.length - 1] as { id: number }).id);
  }
  return { links, images };
}

/** Up to `budget` URLs, taking one per host in turn (hosts in first-seen order, URLs in first-seen order per host). */
export function roundRobin(urls: string[], budget: number): string[] {
  const byHost = new Map<string, string[]>();
  for (const u of urls) {
    const h = new URL(u).host;
    if (!byHost.has(h)) byHost.set(h, []);
    byHost.get(h)!.push(u);
  }
  const queues = [...byHost.values()];
  const out: string[] = [];
  for (let i = 0; out.length < budget; i++) {
    let took = false;
    for (const q of queues) {
      if (i < q.length && out.length < budget) {
        out.push(q[i]);
        took = true;
      }
    }
    if (!took) break;
  }
  return out;
}

async function insertRows(ctx: ResourceContext, kind: ResourceKind, urls: string[], tally: Tally) {
  for (let i = 0; i < urls.length; i += BATCH) {
    const rows = urls.slice(i, i + BATCH).map((url) => ({ url, host: new URL(url).host, referrers: tally.urls.get(url)!.referrers, pages: tally.urls.get(url)!.pages }));
    await ctx.db.execute(sql`insert into resources (crawl_id, kind, url, host, referrers, sample_pages)
      select ${ctx.crawlId}::uuid, ${kind}, v.url, v.host, v.referrers, v.pages
      from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as v(url text, host text, referrers int, pages jsonb)
      on conflict (crawl_id, kind, url) do nothing`);
  }
}

async function saveSummary(ctx: ResourceContext, s: CrawlResourcesSummary) {
  await ctx.db.execute(sql`update crawls set resources = ${JSON.stringify(s)}::jsonb where id = ${ctx.crawlId}::uuid`);
}

/** Plan once per crawl: the rows to check, within budget. A resumed crawl keeps the earlier plan. */
async function plan(ctx: ResourceContext): Promise<CrawlResourcesSummary> {
  if (ctx.existing?.planned) return ctx.existing;
  const extBudget = ctx.limits?.externalLinks ?? MAX_EXTERNAL_LINKS;
  const imgBudget = ctx.limits?.images ?? MAX_IMAGE_URLS;
  const { links, images } = await collect(ctx);
  const ext = roundRobin([...links.urls.keys()], extBudget);
  const img = [...images.urls.keys()].slice(0, imgBudget);
  await insertRows(ctx, "external_link", ext, links);
  await insertRows(ctx, "image", img, images);
  const summary: CrawlResourcesSummary = {
    urlPhaseFinishedAt: ctx.existing?.urlPhaseFinishedAt ?? new Date().toISOString(),
    planned: true,
    external: { found: links.found, planned: ext.length, overBudget: links.found - ext.length, budget: extBudget },
    images: { found: images.found, planned: img.length, overBudget: images.found - img.length, budget: imgBudget },
  };
  await saveSummary(ctx, summary);
  ctx.log("crawl.resources_planned", { crawlId: ctx.crawlId, external: summary.external, images: summary.images });
  return summary;
}

/** RFC 9309 decision function for one host, from its robots.txt (read once). */
type HostRobots = { allows(url: string): string | null } | { noAnswer: { code: string; message: string } };
const NO_ANSWER = new Set(["DNS_FAILED", "TLS", "NETWORK", "BLOCKED_HOST"]);

async function hostRobots(ctx: ResourceContext, host: string, sample: string, throttle: HostThrottle): Promise<HostRobots | null> {
  const ownHost = new URL(ctx.origin).host;
  if (host === ownHost) return { allows: (u) => ctx.robotsBlockedOwn(u) };
  const robotsUrl = new URL("/robots.txt", sample).toString();
  let slot: string;
  try {
    slot = await throttle.acquire(ctx.signal);
  } catch (e) {
    if (ctx.signal.aborted) return null;
    throw e;
  }
  try {
    const res = await ctx.send(robotsUrl, { accept: "robots" }, throttle, slot);
    if (res.status >= 200 && res.status < 300) {
      const parsed = parseRobots(res.body);
      return { allows: (u) => (isAllowed(parsed, ctx.robotsToken, u).allowed ? null : `${robotsUrl} disallows it for ${ctx.robotsToken}`) };
    }
    if (res.status >= 400 && res.status < 500) return { allows: () => null };
    return { allows: () => `${robotsUrl} returned ${res.status}; treated as a full disallow (RFC 9309 §2.3.1.4)` };
  } catch (e) {
    if (ctx.signal.aborted) return null;
    if (e instanceof SafeFetchError && NO_ANSWER.has(e.code)) return { noAnswer: { code: e.code, message: e.message } };
    const why = e instanceof SafeFetchError ? e.message : String((e as Error)?.message ?? e);
    return { allows: () => `${robotsUrl} could not be read (${why}); treated as a full disallow (RFC 9309 §2.3.1.4)` };
  }
}

const setRow = (ctx: ResourceContext, id: number, f: Record<string, unknown>) =>
  ctx.db.execute(sql`update resources r set
      state = coalesce(v.state, r.state), skip_code = coalesce(v.skip_code, r.skip_code), method = coalesce(v.method, r.method),
      status = coalesce(v.status, r.status), content_type = coalesce(v.content_type, r.content_type), bytes = coalesce(v.bytes, r.bytes),
      width = coalesce(v.width, r.width), height = coalesce(v.height, r.height), error = coalesce(v.error, r.error), updated_at = now()
    from jsonb_to_record(${JSON.stringify(f)}::jsonb) as v(state text, skip_code text, method text, status int, content_type text, bytes bigint, width int, height int, error jsonb)
    where r.id = ${id}`);

/** Total size from Content-Range ("bytes 0-65535/123456"), else Content-Length; null when neither says. */
export function totalBytes(headers: Record<string, string>): number | null {
  const range = /\/(\d+)\s*$/.exec(headers["content-range"] ?? "");
  if (range) return Number(range[1]);
  const len = headers["content-length"];
  return len && /^\d+$/.test(len.trim()) ? Number(len) : null;
}

const RASTER = /^image\/(png|jpe?g|gif|webp)\b/i;

/** Check one row. Returns false when the crawl started stopping first (the row stays queued, or started if cut off). */
async function check(ctx: ResourceContext, row: Row, throttle: HostThrottle): Promise<boolean> {
  let slot: string;
  try {
    slot = await throttle.acquire(ctx.signal);
  } catch (e) {
    if (ctx.signal.aborted) return false;
    throw e;
  }
  try {
    await setRow(ctx, row.id, { state: "started" });
  } catch (e) {
    await throttle.release(slot);
    throw e;
  }
  const fail = async (e: unknown) => {
    if (ctx.signal.aborted && !(e instanceof SafeFetchError && e.code !== "NETWORK")) return false; // stays "started": interrupted on resume
    const error = e instanceof SafeFetchError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: String((e as Error)?.message ?? e) };
    await setRow(ctx, row.id, { state: "done", error });
    return true;
  };
  let head: FetchResult;
  try {
    head = await ctx.send(row.url, { accept: "status", method: "HEAD" }, throttle, slot);
  } catch (e) {
    return fail(e);
  }
  // safe-fetch retries a refused HEAD (403/405/501) with GET and says which method answered.
  const result: Record<string, unknown> = { method: head.method ?? "HEAD", status: head.status, content_type: head.contentType || null, bytes: totalBytes(head.headers) };
  if (row.kind === "image" && head.status >= 200 && head.status < 300 && RASTER.test(head.contentType)) {
    try {
      const slot2 = await throttle.acquire(ctx.signal);
      const get = await ctx.send(row.url, { accept: "image", headers: { range: `bytes=0-${MAX_IMAGE_HEAD_BYTES - 1}` } }, throttle, slot2);
      result.method = `${result.method}+GET`;
      if (get.raw) {
        const size = imageSize(get.raw);
        if (size) Object.assign(result, { width: size.width, height: size.height });
      }
      result.bytes = totalBytes(get.headers) ?? result.bytes;
    } catch (e) {
      if (ctx.signal.aborted) {
        await setRow(ctx, row.id, { ...result, state: "done" });
        return false;
      }
      // The HEAD answer stands; dimensions are unknown.
    }
  }
  await setRow(ctx, row.id, { ...result, state: "done" });
  return true;
}

/** All queued rows of one host, one at a time (the throttle spaces them). False when the crawl started stopping. */
async function runHost(ctx: ResourceContext, host: string, rows: Row[]): Promise<boolean> {
  const throttle = ctx.throttle(host);
  const robots = await hostRobots(ctx, host, rows[0].url, throttle);
  if (!robots) return false;
  for (const row of rows) {
    if (ctx.signal.aborted) return false;
    if ("noAnswer" in robots) {
      // The host does not answer at all (e.g. DNS): that is every URL's answer too.
      await setRow(ctx, row.id, { state: "done", error: robots.noAnswer });
      continue;
    }
    const why = robots.allows(row.url);
    if (why) {
      await setRow(ctx, row.id, { state: "skipped", skip_code: "blocked_robots", error: { code: "ROBOTS", message: why } });
      continue;
    }
    if (!(await check(ctx, row, throttle))) return false;
  }
  return true;
}

/** Plan (once) and check every queued resource. Returns false when the crawl started stopping before all were sent. */
export async function runResources(ctx: ResourceContext): Promise<boolean> {
  // Rows a stopped run had already started are never re-sent.
  await ctx.db.execute(sql`update resources set state = 'interrupted', error = ${JSON.stringify({ code: "INTERRUPTED", message: "interrupted before the response was stored" })}::jsonb, updated_at = now()
    where crawl_id = ${ctx.crawlId}::uuid and state = 'started'`);
  const summary = await plan(ctx);
  const r = await ctx.db.execute(sql`select id, kind, url, host from resources where crawl_id = ${ctx.crawlId}::uuid and state = 'queued' order by id`);
  const byHost = new Map<string, Row[]>();
  for (const x of r.rows as { id: number; kind: ResourceKind; url: string; host: string }[]) {
    if (!byHost.has(x.host)) byHost.set(x.host, []);
    byHost.get(x.host)!.push({ id: Number(x.id), kind: x.kind, url: x.url, host: x.host });
  }
  const hosts = [...byHost.keys()];
  let next = 0;
  let stopped = false;
  const lane = async () => {
    while (!stopped && next < hosts.length) {
      const h = hosts[next++];
      if (!(await runHost(ctx, h, byHost.get(h)!))) stopped = true;
    }
  };
  await Promise.all(Array.from({ length: Math.min(HOST_LANES, hosts.length) }, lane));
  if (stopped || ctx.signal.aborted) return false;
  await saveSummary(ctx, { ...summary, finishedAt: new Date().toISOString() });
  ctx.log("crawl.resources_done", { crawlId: ctx.crawlId, hosts: hosts.length });
  return true;
}
