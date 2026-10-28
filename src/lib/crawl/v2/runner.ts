// Crawler v2 runner: drives one crawl from robots.txt to its last URL, with all state in Postgres
// (docs/CRAWLER-STATES.md). Storage-agnostic about the queue: BullMQ jobs only say "run crawl X".
//
// One runner per crawl, enforced by a Postgres session advisory lock held on a dedicated connection. The lock is
// released when the process dies, so the next runner that gets it knows the previous one is gone and can recover
// that crawl's claims immediately (forced sweep) instead of waiting for leases to expire.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { parseHtml } from "../../audit/parse";
import type { Db } from "../../db/client";
import { SafeFetchError, type FetchOptions, type FetchResult, type Fetcher } from "../../fetch/safe-fetch";
import { normaliseUrl } from "../normalise";
import { isAllowed, parseRobots, type ParsedRobots } from "../robots";
import { discoverSitemaps, extractOutlinks, type SitemapDocRecord } from "./discovery";
import {
  ClaimLostError,
  commitToSend,
  DEFAULT_LEASE_MS,
  finalizeUrls,
  INTERRUPTED_REASON,
  recordResult,
  releaseReservations,
  renewLeases,
  reserve,
  sweep,
  upsertUrls,
  type Edge,
  type NewUrl,
  type ReservedUrl,
  type UrlResult,
} from "./frontier";
import type { TerminalState } from "./types";

/** Spec "Crawler engine → Resumability": URLs are claimed in batches of 200. */
export const BATCH_SIZE = 200;
/** Spec: follow at most 10 redirect hops. Each hop is its own URL row, so the cap is applied when the target is inserted. */
export const MAX_REDIRECT_HOPS = 10;
/** Product token matched against robots.txt groups. */
export const ROBOTS_TOKEN = "SiteSentryBot";

/** Stored in `crawls.config`. Profiles (step 8) add scope rules; Phase 1 scope is the start URL's host. */
export interface CrawlConfig {
  seeds?: string[];
  sitemaps?: string[];
}

export interface RobotsRecord {
  url: string;
  /** Written before the request, so a resumed run knows it may have been sent. */
  started: true;
  status: number | null;
  outcome?: "parsed" | "allow_all" | "disallow_all";
  /** Why the outcome was chosen, in report language. */
  reason?: string;
  body?: string;
  sitemaps?: string[];
  error?: { code: string; message: string };
  /** The worker stopped mid-request; robots.txt was requested a second time (see known risks). */
  refetchedAfterInterrupt?: boolean;
}

/** `crawls.sitemaps` entries: a start marker before each request, then the finished document record. */
type SitemapLogEntry = { started: string } | SitemapDocRecord;

export type RunOutcome = "completed" | "paused" | "cancelled" | "locked" | "not_runnable" | "shutdown";

export interface RunnerOptions {
  db: Db;
  fetch: Fetcher;
  /** Worker identity; each run adds a suffix so leases are per run. */
  owner: string;
  leaseMs?: number;
  batchSize?: number;
  /** Requests in flight for this crawl. Step 6 replaces this with the per-host politeness controller. */
  concurrency?: number;
  fetchOptions?: Pick<FetchOptions, "timeoutMs" | "maxBytes" | "userAgent">;
  signal?: AbortSignal;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

interface CrawlRow {
  id: string;
  site_origin: string;
  status: string;
  budget: number | null;
  max_depth: number | null;
  config: CrawlConfig;
  robots: RobotsRecord | null;
  sitemaps: SitemapLogEntry[];
  discovery_done: boolean;
}

async function loadCrawl(db: Db, crawlId: string): Promise<CrawlRow | undefined> {
  const r = await db.execute(sql`select id, site_origin, status, budget, max_depth, config, robots, sitemaps, discovery_done from crawls where id = ${crawlId}::uuid`);
  return r.rows[0] as unknown as CrawlRow | undefined;
}

async function crawlStatus(db: Db, crawlId: string): Promise<string | undefined> {
  const r = await db.execute(sql`select status from crawls where id = ${crawlId}::uuid`);
  return (r.rows[0] as { status: string } | undefined)?.status;
}

export async function runCrawl(opts: RunnerOptions, crawlId: string): Promise<RunOutcome> {
  const { db } = opts;
  const log = opts.log ?? (() => {});
  const client = await db.$client.connect();
  let locked = false;
  try {
    const got = await client.query(`select pg_try_advisory_lock(hashtextextended($1, 0)) as ok`, [`crawl:${crawlId}`]);
    locked = got.rows[0]?.ok === true;
    if (!locked) {
      log("crawl.locked", { crawlId });
      return "locked";
    }
    return await new Run(opts, crawlId, log).execute();
  } finally {
    if (locked) await client.query(`select pg_advisory_unlock(hashtextextended($1, 0))`, [`crawl:${crawlId}`]).catch(() => {});
    client.release();
  }
}

class Run {
  private readonly owner: string;
  private readonly leaseMs: number;
  private crawl!: CrawlRow;
  private robots: ParsedRobots | null = null;
  private robotsRecord: RobotsRecord | null = null;
  private host = "";

  constructor(
    private readonly opts: RunnerOptions,
    private readonly crawlId: string,
    private readonly log: NonNullable<RunnerOptions["log"]>,
  ) {
    this.owner = `${opts.owner}/${randomUUID().slice(0, 8)}`;
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  }

  private get db() {
    return this.opts.db;
  }

  async execute(): Promise<RunOutcome> {
    const crawl = await loadCrawl(this.db, this.crawlId);
    if (!crawl || ["completed", "cancelled", "failed"].includes(crawl.status)) return "not_runnable";
    if (crawl.status === "paused") return "paused";
    this.crawl = crawl;
    this.host = new URL(crawl.site_origin).host;

    // We hold the lock, so no other runner is alive for this crawl: recover its claims now.
    const recovered = await sweep(this.db, this.crawlId, { force: true });
    if (recovered.requeued || recovered.interrupted) this.log("crawl.recovered", { crawlId: this.crawlId, ...recovered });

    if (crawl.status === "cancelling") return this.finishCancelled();
    if (crawl.status === "queued") {
      await this.db.execute(sql`update crawls set status = 'running', started_at = coalesce(started_at, now()) where id = ${this.crawlId}::uuid and status = 'queued'`);
    }

    const renew = setInterval(() => void renewLeases(this.db, this.owner, this.leaseMs).catch(() => {}), Math.max(1000, this.leaseMs / 3));
    renew.unref();
    try {
      await this.loadRobots();
      const stop = await this.checkStop();
      if (stop) return stop;
      await this.seed();
      if (!crawl.discovery_done) {
        const stopped = await this.discover();
        if (stopped) return stopped;
      }
      return await this.crawlLoop();
    } finally {
      clearInterval(renew);
      await releaseReservations(this.db, this.owner).catch(() => {});
    }
  }

  // ---------- robots.txt ----------

  private async loadRobots() {
    let rec = this.crawl.robots;
    if (rec?.outcome) {
      this.applyRobots(rec);
      return;
    }
    const url = new URL("/robots.txt", this.crawl.site_origin).toString();
    const interrupted = rec?.started === true;
    rec = { url, started: true, status: null, ...(interrupted ? { refetchedAfterInterrupt: true } : {}) };
    await this.saveRobots(rec);
    try {
      const res = await this.opts.fetch(url, { accept: "robots", signal: this.opts.signal, ...this.opts.fetchOptions });
      rec.status = res.status;
      if (res.status >= 200 && res.status < 300) {
        const parsed = parseRobots(res.body);
        Object.assign(rec, { outcome: "parsed", reason: `robots.txt returned ${res.status}.`, body: res.body, sitemaps: parsed.sitemaps });
      } else if (res.status >= 400 && res.status < 500) {
        Object.assign(rec, { outcome: "allow_all", reason: `robots.txt returned ${res.status}; crawling is unrestricted (RFC 9309 §2.3.1.3).`, sitemaps: [] });
      } else {
        Object.assign(rec, { outcome: "disallow_all", reason: `robots.txt returned ${res.status}; treated as a full disallow (RFC 9309 §2.3.1.4).`, sitemaps: [] });
      }
    } catch (e) {
      const err = e instanceof SafeFetchError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: String((e as Error)?.message ?? e) };
      Object.assign(rec, { error: err, outcome: "disallow_all", reason: `robots.txt could not be fetched (${err.message}); treated as a full disallow (RFC 9309 §2.3.1.4).`, sitemaps: [] });
    }
    await this.saveRobots(rec);
    this.applyRobots(rec);
  }

  private async saveRobots(rec: RobotsRecord) {
    await this.db.execute(sql`update crawls set robots = ${JSON.stringify(rec)}::jsonb where id = ${this.crawlId}::uuid`);
  }

  private applyRobots(rec: RobotsRecord) {
    this.robotsRecord = rec;
    this.robots = rec.outcome === "parsed" ? parseRobots(rec.body ?? "") : null;
  }

  // ---------- scope and classification ----------

  /** Terminal state for a URL that must not be fetched, or null when it is crawlable. */
  private gate(url: string): { state: TerminalState; reason: string } | null {
    const u = new URL(url);
    if (u.host !== this.host) return { state: "out_of_scope", reason: `Different host (${u.host}); this crawl covers ${this.host}.` };
    if (this.robotsRecord?.outcome === "disallow_all") return { state: "blocked_robots", reason: this.robotsRecord.reason! };
    if (this.robots) {
      const d = isAllowed(this.robots, ROBOTS_TOKEN, url);
      if (!d.allowed) return { state: "blocked_robots", reason: `robots.txt ${d.matchedRule ?? "rule"} applies to ${ROBOTS_TOKEN}.` };
    }
    return null;
  }

  private newUrl(url: string, original: string, via: NewUrl["via"], depth: number | null, redirectHops = 0): NewUrl {
    const g = this.gate(url);
    return { url, original, via, depth, redirectHops, ...(g ? { state: g.state, reason: g.reason } : {}) };
  }

  // ---------- seeds and sitemaps ----------

  private async seed() {
    const raw = this.crawl.config?.seeds?.length ? this.crawl.config.seeds : [new URL("/", this.crawl.site_origin).toString()];
    const seeds: NewUrl[] = [];
    for (const s of raw) {
      const n = normaliseUrl(s);
      if (n.ok) seeds.push(this.newUrl(n.url, s, "seed", 0));
    }
    await upsertUrls(this.db, this.crawlId, seeds);
  }

  /** Read every sitemap once (resuming an interrupted discovery without re-requesting any document). */
  private async discover(): Promise<RunOutcome | null> {
    const log = this.crawl.sitemaps ?? [];
    const prior = {
      started: log.filter((e): e is { started: string } => "started" in e).map((e) => e.started),
      docs: log.filter((e): e is SitemapDocRecord => !("started" in e)),
    };
    const append = (entry: SitemapLogEntry) =>
      this.db.execute(sql`update crawls set sitemaps = sitemaps || jsonb_build_array(${JSON.stringify(entry)}::jsonb) where id = ${this.crawlId}::uuid`);
    const events = discoverSitemaps({
      origin: this.crawl.site_origin,
      robotsSitemaps: this.robotsRecord?.sitemaps ?? [],
      configured: this.crawl.config?.sitemaps,
      fetch: (url, o) => this.opts.fetch(url, { ...o, signal: this.opts.signal, ...this.opts.fetchOptions, maxBytes: undefined }),
      prior,
    });
    for await (const e of events) {
      if (e.type === "start") {
        const stop = await this.checkStop();
        if (stop) return stop;
        await append({ started: e.url });
      } else if (e.type === "doc") {
        await append(e.doc);
      } else {
        await upsertUrls(this.db, this.crawlId, e.urls.map((u) => this.newUrl(u.url, u.original, "sitemap", null)));
      }
    }
    await this.db.execute(sql`update crawls set discovery_done = true where id = ${this.crawlId}::uuid`);
    return null;
  }

  // ---------- the fetch loop ----------

  /** Returns the outcome to stop with when the crawl is no longer running, else null. */
  private async checkStop(): Promise<RunOutcome | null> {
    if (this.opts.signal?.aborted) return "shutdown";
    const status = await crawlStatus(this.db, this.crawlId);
    if (status === "running") return null;
    if (status === "paused") return "paused";
    if (status === "cancelling") return this.finishCancelled();
    return "not_runnable";
  }

  private async crawlLoop(): Promise<RunOutcome> {
    const batchSize = this.opts.batchSize ?? BATCH_SIZE;
    for (;;) {
      const stop = await this.checkStop();
      if (stop) return stop;
      const batch = await reserve(this.db, this.crawlId, this.owner, batchSize, this.crawl.max_depth, this.leaseMs);
      if (!batch.length) return this.finishCompleted();
      const halted = await this.processBatch(batch);
      await releaseReservations(this.db, this.owner);
      if (halted === "stopped") {
        const s = await this.checkStop();
        if (s) return s;
      }
    }
  }

  private async processBatch(batch: ReservedUrl[]): Promise<"budget" | "stopped" | null> {
    const concurrency = this.opts.concurrency ?? 3;
    let next = 0;
    let halted: "budget" | "stopped" | null = null;
    let failed: unknown = null;
    const lane = async () => {
      try {
        await work();
      } catch (e) {
        // Stop the other lanes too; the error is rethrown once they have finished their current URL.
        halted = "stopped";
        failed ??= e;
      }
    };
    const work = async () => {
      while (!halted && next < batch.length) {
        if (this.opts.signal?.aborted) {
          halted = "stopped";
          return;
        }
        const r = batch[next++];
        const commit = await commitToSend(this.db, this.crawlId, r.id, this.owner, this.leaseMs);
        if (!commit.ok) {
          if (commit.why !== "lost") halted = commit.why;
          continue;
        }
        const result = await this.fetchOne(r);
        try {
          await recordResult(this.db, this.crawlId, r.id, commit.token, result);
        } catch (e) {
          if (!(e instanceof ClaimLostError)) throw e;
          this.log("crawl.claim_lost", { crawlId: this.crawlId, url: r.url });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, lane));
    if (failed) throw failed;
    return halted;
  }

  private async fetchOne(r: ReservedUrl): Promise<UrlResult> {
    let res: FetchResult;
    try {
      res = await this.opts.fetch(r.url, { accept: "html", followRedirects: false, signal: this.opts.signal, ...this.opts.fetchOptions });
    } catch (e) {
      // Shutting down mid-request: it may have reached the server, so it is not retried.
      if (this.opts.signal?.aborted) return { state: "interrupted", reason: INTERRUPTED_REASON };
      return failure(e);
    }
    const base = { statusCode: res.status, contentType: res.contentType || null, elapsedMs: res.elapsedMs, bytes: res.bytes };

    if (res.status >= 300 && res.status < 400 && res.location) {
      const target = normaliseUrl(res.location);
      if (!target.ok) return { ...base, state: "redirected", reason: `HTTP ${res.status} to an unusable Location (${target.reason}): ${res.location.slice(0, 300)}`, redirectTarget: res.location };
      const hops = r.redirectHops + 1;
      const next =
        hops > MAX_REDIRECT_HOPS
          ? { url: target.url, original: res.location, via: "redirect" as const, depth: r.depth, redirectHops: hops, state: "excluded_by_rule" as const, reason: `Redirect chain longer than ${MAX_REDIRECT_HOPS} hops; not followed.` }
          : this.newUrl(target.url, res.location, "redirect", r.depth, hops);
      const edge: Edge = { fromUrl: r.url, toUrl: target.url, via: "redirect", anchor: null, rel: null, location: null, nofollow: false };
      return { ...base, state: "redirected", reason: `HTTP ${res.status} → ${target.url}`, redirectTarget: target.url, newUrls: [next], edges: [edge] };
    }

    const snapshot = {
      finalUrl: res.finalUrl,
      statusCode: res.status,
      contentType: res.contentType,
      headers: res.headers,
      bytes: res.bytes,
      truncated: res.truncated,
      elapsedMs: res.elapsedMs,
      contentHash: res.body ? createHash("sha256").update(res.body).digest("hex") : null,
      outlinkCount: 0,
    };
    const ok = res.status >= 200 && res.status < 300;
    if (ok && !res.contentTypeAccepted) {
      return { ...base, state: "non_html", reason: `Content-Type ${res.contentType || "(none)"} is not HTML.`, snapshot };
    }
    if (!ok) return { ...base, state: "fetched", reason: `HTTP ${res.status}`, snapshot };

    const out = extractOutlinks(parseHtml(res.body), res.finalUrl);
    const childDepth = (r.depth ?? 0) + 1; // a sitemap-only page counts as depth 0 for its children
    const newUrls = out.links.map((l) => this.newUrl(l.url, l.original, l.via, childDepth));
    const edges: Edge[] = out.links.map((l) => ({ fromUrl: r.url, toUrl: l.url, via: l.via, anchor: l.anchor, rel: l.rel || null, location: l.location, nofollow: l.nofollow }));
    snapshot.outlinkCount = out.links.length;
    if (res.truncated) {
      return { ...base, state: "oversized", reason: `HTML larger than the ${res.bytes}-byte cap; the first ${res.bytes} bytes were read.`, snapshot, newUrls, edges };
    }
    return { ...base, state: "fetched", reason: `HTTP ${res.status}`, snapshot, newUrls, edges };
  }

  // ---------- endings ----------

  private async finishCompleted(): Promise<RunOutcome> {
    const stop = await this.checkStop();
    if (stop) return stop;
    await finalizeUrls(this.db, this.crawlId, "completed", this.crawl.max_depth, this.crawl.budget);
    await this.db.execute(sql`update crawls set status = 'completed', finished_at = now() where id = ${this.crawlId}::uuid and status = 'running'`);
    this.log("crawl.completed", { crawlId: this.crawlId });
    return "completed";
  }

  private async finishCancelled(): Promise<RunOutcome> {
    await releaseReservations(this.db, this.owner);
    await finalizeUrls(this.db, this.crawlId, "cancelled", null, null);
    await this.db.execute(sql`update crawls set status = 'cancelled', finished_at = now() where id = ${this.crawlId}::uuid and status = 'cancelling'`);
    this.log("crawl.cancelled", { crawlId: this.crawlId });
    return "cancelled";
  }
}

function failure(e: unknown): UrlResult {
  if (!(e instanceof SafeFetchError)) return { state: "failed_network", reason: `Unexpected error: ${(e as Error)?.message ?? String(e)}` };
  const state: TerminalState =
    e.code === "TIMEOUT" ? "failed_timeout" : e.code === "DNS_FAILED" ? "failed_dns" : /certificate|tls|ssl/i.test(e.message) ? "failed_tls" : "failed_network";
  return { state, reason: `${e.code}: ${e.message}` };
}
