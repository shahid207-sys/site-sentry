// Crawler v2 runner: drives one crawl from robots.txt to its last URL, with all state in Postgres
// (docs/CRAWLER-STATES.md). Storage-agnostic about the queue: BullMQ jobs only say "run crawl X".
//
// One runner per crawl, enforced by a Postgres session advisory lock held on a dedicated connection. The lock is
// released when the process dies, so the next runner that gets it knows the previous one is gone and can recover
// that crawl's claims immediately (forced sweep) instead of waiting for leases to expire.
import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import { parseHtml } from "../../audit/parse";
import { blobStoreFromEnv, putRawHtml, type BlobStore } from "../../snapshot/blob-store";
import { extractHtml } from "../../snapshot/extract";
import type { Db } from "../../db/client";
import { SafeFetchError, type FetchOptions, type FetchResult, type Fetcher, type PeerCertReader } from "../../fetch/safe-fetch";
import { normaliseUrl } from "../normalise";
import type { ScopeRules } from "../profiles";
import { crawlDelayFor, isAllowed, parseRobots, type ParsedRobots } from "../robots";
import { compileRules, ruleVerdict, ScopeRuleError } from "../scope-rules";
import { discoverSitemaps, extractOutlinks, type SitemapDocRecord } from "./discovery";
import {
  ClaimLostError,
  commitToSend,
  DEFAULT_LEASE_MS,
  finalizeUrls,
  INTERRUPTED_REASON,
  recordResult,
  recordRetry,
  requeueRefused,
  releaseReservations,
  renewLeases,
  reserve,
  sweep,
  upsertUrls,
  type Edge,
  type NewUrl,
  type ReservedUrl,
  type SnapshotRow,
  type UrlResult,
} from "./frontier";
import { HostThrottle, parseRetryAfter, type ThrottleOptions } from "./politeness";
import { runResources, type CrawlResourcesSummary } from "./resources";
import { runProbes } from "./probes";
import type { ProbeRecord } from "../../rules/probe-types";
import { crawlSecretScope, decryptSecret, secretKey } from "./secrets";
import type { TerminalState } from "./types";

/** Spec "Crawler engine → Resumability": URLs are claimed in batches of 200. */
export const BATCH_SIZE = 200;
/** Spec: follow at most 10 redirect hops. Each hop is its own URL row, so the cap is applied when the target is inserted. */
export const MAX_REDIRECT_HOPS = 10;
/** Product token matched against robots.txt groups. */
export const ROBOTS_TOKEN = "SiteSentryBot";
/** Spec "Crawler engine → Politeness and speed": default user-agent and fetch limits (connect timeout is the agent's 10 s). */
export const V2_USER_AGENT = "SiteSentryBot/1.0 (+https://sitesentry.app/bot)";
export const V2_TOTAL_TIMEOUT_MS = 30_000;
export const V2_MAX_HTML_BYTES = 5 * 1024 * 1024;
/**
 * A 429/503 is requested again at most this many times, after the throttle's backoff (or Retry-After), and only when
 * the server does not ask for a longer wait than RETRY_WAIT_CAP_MS. The server refused those requests, so repeating
 * them does not break at-most-once fetching; every request is counted in `crawl_urls.attempts`.
 */
export const MAX_THROTTLE_RETRIES = 2;
export const RETRY_WAIT_CAP_MS = 60_000;
/** How often a running crawl re-reads crawls.status, so a pause or cancel takes effect within about this long. */
export const STATUS_POLL_MS = 500;

/** Stored in `crawls.config`. Scope is always the start URL's host; the Custom profile can narrow it further. */
export interface CrawlConfig {
  seeds?: string[];
  sitemaps?: string[];
  scope?: ScopeRules;
  /** Basic auth for the crawl's own origin. `password` is encrypted (secrets.ts), never plaintext. */
  auth?: { username: string; password: string };
  /** The user's intent for AI crawlers (AIS-002); unset means the rule reports needs_config. */
  aiCrawlers?: "allow" | "block";
  /** Pages the user marks as high-value (LNK-012); unset means the rule reports needs_config. */
  keyPages?: string[];
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

export type RunOutcome = "completed" | "paused" | "cancelled" | "failed" | "locked" | "not_runnable" | "shutdown";

export interface RunnerOptions {
  db: Db;
  fetch: Fetcher;
  /** Reads the start host's TLS certificate (tls_cert probe, SEC-003), with the same SSRF policy as `fetch`. */
  peerCert?: PeerCertReader;
  /** Per-crawl resource budgets (default 500 external links, 2,000 images); lowered only by tests. */
  resourceLimits?: { externalLinks?: number; images?: number };
  /** Worker identity; each run adds a suffix so leases are per run. */
  owner: string;
  leaseMs?: number;
  batchSize?: number;
  /** Holds the per-host politeness state shared by every worker (politeness.ts). */
  redis: Redis;
  /** Per-host limits. Defaults: 3 in flight, 5 req/s. */
  politeness?: Pick<ThrottleOptions, "maxConcurrency" | "ratePerSecond" | "keyPrefix">;
  /** A throttle to use instead of the default one for the crawl's host (tests). */
  throttle?: HostThrottle;
  /** Overrides for the spec defaults (V2_TOTAL_TIMEOUT_MS, V2_MAX_HTML_BYTES, V2_USER_AGENT). */
  fetchOptions?: Pick<FetchOptions, "timeoutMs" | "maxBytes" | "userAgent">;
  signal?: AbortSignal;
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** Where raw HTML is stored gzipped. Default: blobStoreFromEnv() (BLOB_DIR, else .data/blobs). */
  blobs?: BlobStore;
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
  probes: ProbeRecord[];
  resources: CrawlResourcesSummary | null;
  discovery_done: boolean;
  start_redirect: StartRedirect | null;
}

/**
 * What the start URL did before the crawl began. "twin": it redirected to the same site's www/non-www or http/https
 * variant, and the crawl moved there (site_origin is the target; `from` keeps what the user asked for). "off_host":
 * it redirected to another site, and the crawl ended as failed with start_redirected_off_host. "none": no redirect
 * off the start origin (or the check could not get an answer; the seed fetch then records why).
 */
export interface StartRedirect {
  kind: "none" | "twin" | "off_host";
  from: string;
  to: string | null;
  hops: { url: string; status: number }[];
  error?: string;
}

/** Same site, other door: hostnames equal once a leading "www." is dropped, scheme http or https, same explicit port. */
export function isTwinOrigin(a: URL, b: URL): boolean {
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, "");
  return a.origin !== b.origin && /^https?:$/.test(b.protocol) && bare(a.hostname) === bare(b.hostname) && a.port === b.port;
}

/** Redirect hops followed while resolving the start URL. */
const START_MAX_HOPS = 5;

async function loadCrawl(db: Db, crawlId: string): Promise<CrawlRow | undefined> {
  const r = await db.execute(sql`select id, site_origin, status, budget, max_depth, config, robots, sitemaps, probes, resources, discovery_done, start_redirect from crawls where id = ${crawlId}::uuid`);
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
  private origin = "";
  private throttle!: HostThrottle;
  private scope: { include: [string, RegExp][]; exclude: [string, RegExp][]; subfolder: string | null } = { include: [], exclude: [], subfolder: null };
  private authHeader: string | null = null;
  /** Aborted by a pause or cancel (crawls.status) or worker shutdown: ends every wait, and no new request starts. */
  private readonly stopping = new AbortController();
  /** Aborted by a cancel or worker shutdown: also ends requests in flight. A pause lets them finish. */
  private readonly cancelling = new AbortController();
  private readonly signal: AbortSignal;
  private readonly fetchSignal: AbortSignal;

  constructor(
    private readonly opts: RunnerOptions,
    private readonly crawlId: string,
    private readonly log: NonNullable<RunnerOptions["log"]>,
  ) {
    this.owner = `${opts.owner}/${randomUUID().slice(0, 8)}`;
    this.leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
    const shutdown = opts.signal ? [opts.signal] : [];
    this.signal = AbortSignal.any([...shutdown, this.stopping.signal]);
    this.fetchSignal = AbortSignal.any([...shutdown, this.cancelling.signal]);
  }

  /** Re-read crawls.status every STATUS_POLL_MS; a pause or cancel aborts the waits (and, for cancel, the requests). */
  private watchStatus(): () => void {
    const timer = setInterval(() => {
      void crawlStatus(this.db, this.crawlId)
        .then((status) => {
          if (status === "running") return;
          this.stopping.abort(new Error(`crawl ${status ?? "deleted"}`));
          if (status !== "paused") this.cancelling.abort(new Error(`crawl ${status ?? "deleted"}`));
        })
        .catch(() => {}); // a missed poll is retried on the next tick
    }, STATUS_POLL_MS);
    timer.unref();
    return () => clearInterval(timer);
  }

  private get db() {
    return this.opts.db;
  }

  private _blobs: BlobStore | null = null;
  private get blobs(): BlobStore {
    return (this._blobs ??= this.opts.blobs ?? blobStoreFromEnv());
  }

  async execute(): Promise<RunOutcome> {
    const crawl = await loadCrawl(this.db, this.crawlId);
    if (!crawl || ["completed", "cancelled", "failed"].includes(crawl.status)) return "not_runnable";
    if (crawl.status === "paused") return "paused";
    this.crawl = crawl;
    this.host = new URL(crawl.site_origin).host;
    this.origin = new URL(crawl.site_origin).origin;
    this.throttle = this.opts.throttle ?? new HostThrottle(this.opts.redis, this.host, this.opts.politeness);
    const scope = crawl.config?.scope;
    try {
      this.scope = { include: compileRules(scope?.include, "Include"), exclude: compileRules(scope?.exclude, "Exclude"), subfolder: scope?.subfolder ?? null };
    } catch (e) {
      if (!(e instanceof ScopeRuleError)) throw e;
      return this.finishFailed({ code: e.code, message: `${e.message} Edit the rule and start a new audit.` });
    }
    if (crawl.config?.auth) {
      const key = secretKey();
      if (!key) throw new Error("This crawl uses basic auth, but CRAWLER_SECRET_KEY is not set on the worker.");
      const password = decryptSecret(crawl.config.auth.password, key, crawlSecretScope(this.crawlId));
      this.authHeader = `Basic ${Buffer.from(`${crawl.config.auth.username}:${password}`).toString("base64")}`;
    }

    // We hold the lock, so no other runner is alive for this crawl: recover its claims now.
    const recovered = await sweep(this.db, this.crawlId, { force: true });
    if (recovered.requeued || recovered.interrupted) this.log("crawl.recovered", { crawlId: this.crawlId, ...recovered });

    if (crawl.status === "cancelling") return this.finishCancelled();
    if (crawl.status === "queued") {
      await this.db.execute(sql`update crawls set status = 'running', started_at = coalesce(started_at, now()) where id = ${this.crawlId}::uuid and status = 'queued'`);
    }

    const renew = setInterval(() => void renewLeases(this.db, this.owner, this.leaseMs).catch(() => {}), Math.max(1000, this.leaseMs / 3));
    renew.unref();
    const unwatch = this.watchStatus();
    try {
      await this.throttle.attach(this.crawlId);
      if (!(await this.loadRobots())) return (await this.checkStop()) ?? "shutdown";
      const stop = await this.checkStop();
      if (stop) return stop;
      await this.seed();
      const start = await this.resolveStart();
      if (start === "stopped") return (await this.checkStop()) ?? "shutdown";
      if (start?.kind === "off_host") {
        return this.finishFailed({ code: "start_redirected_off_host", message: `Started at ${start.from}, which redirects to ${start.to}, another site. Start a new audit on that site to crawl it.` });
      }
      if (!crawl.discovery_done) {
        const stopped = await this.discover();
        if (stopped) return stopped;
      }
      return await this.crawlLoop();
    } finally {
      unwatch();
      clearInterval(renew);
      await releaseReservations(this.db, this.owner).catch(() => {});
      // Prune the host's shared throttle state if no other crawl uses it; a TTL covers a worker killed before this.
      const pruned = await this.throttle.detach(this.crawlId).catch(() => "error" as const);
      this.log("crawl.throttle_detached", { crawlId: this.crawlId, host: this.host, pruned });
    }
  }

  // ---------- start URL ----------

  /**
   * After robots.txt and before sitemaps: fetch the start URL on its own, through the normal fetch path (no extra
   * request). If it redirects to the same site's www/non-www or http/https twin, the crawl moves there: the twin's
   * robots.txt is read, the target becomes the seed, and the check repeats (http apex → https apex → https www). If it
   * redirects to another site, the caller ends the crawl. Checked once; the result is stored on the crawl.
   */
  private async resolveStart(): Promise<StartRedirect | "stopped" | null> {
    if (this.crawl.start_redirect) return this.crawl.start_redirect;
    if (this.crawl.config?.seeds?.length) return null; // explicit seeds: the user chose the URLs
    const from = this.startUrl();
    const rec: StartRedirect = { kind: "none", from, to: null, hops: [] };
    for (let hop = 0; hop < START_MAX_HOPS; hop++) {
      const cur = this.startUrl();
      let row = await this.urlRow(cur);
      if (row && (row.state === "discovered" || row.state === "queued")) {
        const batch = (await reserve(this.db, this.crawlId, this.owner, 1, this.crawl.max_depth, this.leaseMs)).filter((r) => Number(r.id) === Number(row!.id));
        if (batch.length) await this.processBatch(batch);
        await releaseReservations(this.db, this.owner);
        if (this.signal.aborted) return "stopped";
        row = await this.urlRow(cur);
      }
      if (row?.state !== "redirected" || !row.redirect_target) break;
      const next = new URL(row.redirect_target);
      rec.hops.push({ url: cur, status: row.status_code ?? 0 });
      if (next.origin === new URL(cur).origin) break; // a path redirect on the same host: the crawl follows it as usual
      if (!isTwinOrigin(new URL(from), next)) {
        Object.assign(rec, { kind: "off_host", to: next.toString() });
        break;
      }
      Object.assign(rec, { kind: "twin", to: next.toString() });
      if (!(await this.rehome(next))) return "stopped";
    }
    await this.db.execute(sql`update crawls set start_redirect = ${JSON.stringify(rec)}::jsonb where id = ${this.crawlId}::uuid`);
    this.crawl.start_redirect = rec;
    if (rec.kind !== "none") this.log("crawl.start_redirect", { crawlId: this.crawlId, ...rec });
    return rec;
  }

  private startUrl(): string {
    return new URL(this.scope.subfolder ?? "/", this.crawl.site_origin).toString();
  }

  private async urlRow(url: string) {
    const n = normaliseUrl(url);
    if (!n.ok) return undefined;
    const r = await this.db.execute(sql`select id, state, status_code, redirect_target from crawl_urls where crawl_id = ${this.crawlId}::uuid and normalised_url = ${n.url}`);
    return r.rows[0] as { id: number; state: string; status_code: number | null; redirect_target: string | null } | undefined;
  }

  /**
   * Move the crawl to the twin origin of `target`: new host throttle, that host's robots.txt, and the URLs already
   * filed out of scope on it (the redirect target) filed again as seeds under the new host's rules. Nothing but the
   * start URL has been fetched yet, so nothing else needs re-filing.
   */
  private async rehome(target: URL): Promise<boolean> {
    this.crawl.site_origin = target.origin;
    this.host = target.host;
    this.origin = target.origin;
    await this.db.execute(sql`update crawls set site_origin = ${target.origin}, robots = null where id = ${this.crawlId}::uuid`);
    if (!this.opts.throttle) {
      await this.throttle.detach(this.crawlId).catch(() => {});
      this.throttle = new HostThrottle(this.opts.redis, this.host, this.opts.politeness);
      await this.throttle.attach(this.crawlId);
    }
    this.crawl.robots = null;
    if (!(await this.loadRobots())) return false;
    const moved = await this.db.execute(sql`delete from crawl_urls where crawl_id = ${this.crawlId}::uuid and state = 'out_of_scope'
      and split_part(split_part(normalised_url, '//', 2), '/', 1) = ${this.host} returning url`);
    const seeds = (moved.rows as { url: string }[]).map((r) => r.url);
    await upsertUrls(this.db, this.crawlId, [...new Set([...seeds, this.startUrl()])].map((u) => this.newUrl(u, u, "seed", 0)));
    return true;
  }

  // ---------- robots.txt ----------

  // ---------- requests ----------

  private get timeoutMs() {
    return this.opts.fetchOptions?.timeoutMs ?? V2_TOTAL_TIMEOUT_MS;
  }

  /** Every request this crawl makes: inside a host throttle slot, with the v2 timeout and user-agent. */
  private async request(url: string, o: Omit<FetchOptions, "signal" | "timeoutMs" | "userAgent">, held?: string, throttle = this.throttle): Promise<FetchResult> {
    const slot = held ?? (await throttle.acquire(this.signal));
    try {
      const res = await this.opts.fetch(url, {
        ...o,
        // Credentials go to the crawl's own origin only (configured sitemaps can live elsewhere).
        headers: this.authHeader && new URL(url).origin === this.origin ? { ...o.headers, authorization: this.authHeader } : o.headers,
        signal: this.fetchSignal,
        timeoutMs: this.timeoutMs,
        userAgent: this.opts.fetchOptions?.userAgent ?? V2_USER_AGENT,
      });
      await throttle.release(slot, { status: res.status, elapsedMs: res.elapsedMs, retryAfterMs: parseRetryAfter(res.headers["retry-after"]) });
      return res;
    } catch (e) {
      // A timeout is the slowest possible response; other failures say nothing about the server's pace.
      await throttle.release(slot, e instanceof SafeFetchError && e.code === "TIMEOUT" ? { status: 0, elapsedMs: this.timeoutMs } : {});
      throw e;
    }
  }

  /** False when the crawl is stopping (shutdown, pause, cancel); robots.txt then stays "started" and is requested again on resume. */
  private async loadRobots(): Promise<boolean> {
    let rec = this.crawl.robots;
    if (rec?.outcome) {
      await this.applyRobots(rec);
      return true;
    }
    const url = new URL("/robots.txt", this.crawl.site_origin).toString();
    const interrupted = rec?.started === true;
    rec = { url, started: true, status: null, ...(interrupted ? { refetchedAfterInterrupt: true } : {}) };
    await this.saveRobots(rec);
    try {
      const res = await this.request(url, { accept: "robots" });
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
      if (this.signal.aborted) return false;
      const err = e instanceof SafeFetchError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: String((e as Error)?.message ?? e) };
      Object.assign(rec, { error: err, outcome: "disallow_all", reason: `robots.txt could not be fetched (${err.message}); treated as a full disallow (RFC 9309 §2.3.1.4).`, sitemaps: [] });
    }
    await this.saveRobots(rec);
    await this.applyRobots(rec);
    return true;
  }

  private async saveRobots(rec: RobotsRecord) {
    await this.db.execute(sql`update crawls set robots = ${JSON.stringify(rec)}::jsonb where id = ${this.crawlId}::uuid`);
  }

  private async applyRobots(rec: RobotsRecord) {
    this.robotsRecord = rec;
    this.robots = rec.outcome === "parsed" ? parseRobots(rec.body ?? "") : null;
    const delay = this.robots ? crawlDelayFor(this.robots, ROBOTS_TOKEN) : null;
    await this.throttle.setCrawlDelay(delay === null ? null : delay * 1000);
  }

  // ---------- scope and classification ----------

  /** Terminal state for a URL that must not be fetched, or null when it is crawlable. */
  private gate(url: string): { state: TerminalState; reason: string } | null {
    const u = new URL(url);
    if (u.host !== this.host) return { state: "out_of_scope", reason: `Different host (${u.host}); this crawl covers ${this.host}.` };
    const { subfolder, include, exclude } = this.scope;
    if (subfolder && !u.pathname.startsWith(subfolder)) return { state: "out_of_scope", reason: `Outside ${subfolder}; this crawl covers only that subfolder.` };
    const ruled = ruleVerdict(url, include, exclude);
    if (ruled) return { state: "excluded_by_rule", reason: ruled };
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
    const start = new URL(this.scope.subfolder ?? "/", this.crawl.site_origin).toString();
    const raw = this.crawl.config?.seeds?.length ? this.crawl.config.seeds : [start];
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
      fetch: (url, o) => this.request(url, o),
      prior,
    });
    for await (const e of events) {
      if (e.type === "start") {
        const stop = await this.checkStop();
        if (stop) return stop;
        await append({ started: e.url });
      } else if (e.type === "doc") {
        // Stopping mid-request: leave the document "started" so a resumed run files it as interrupted.
        if (e.doc.error && this.signal.aborted) return (await this.checkStop()) ?? "shutdown";
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
        if (this.signal.aborted) {
          halted = "stopped";
          return;
        }
        const r = batch[next++];
        // Take the host slot before committing, so a committed URL never waits out a backoff unsent.
        let slot: string;
        try {
          slot = await this.throttle.acquire(this.signal);
        } catch (e) {
          if (!this.signal.aborted) throw e;
          halted = "stopped"; // aborted while waiting; the reservation is released
          return;
        }
        const commit = await commitToSend(this.db, this.crawlId, r.id, this.owner, this.leaseMs).catch(async (e) => {
          await this.throttle.release(slot);
          throw e;
        });
        if (!commit.ok) {
          await this.throttle.release(slot);
          if (commit.why !== "lost") halted = commit.why;
          continue;
        }
        try {
          const result = await this.fetchOne(r, commit.token, slot);
          if ("requeue" in result) {
            await requeueRefused(this.db, this.crawlId, r.id, commit.token);
            this.log("crawl.requeued", { crawlId: this.crawlId, url: r.url, why: result.requeue });
          }
          else {
            if (result.rawHtml && result.snapshot) {
              result.snapshot.rawHtmlKey = await this.storeHtml(r, result.rawHtml);
              result.snapshot.blobStatus = result.snapshot.rawHtmlKey ? "stored" : "blob_missing";
            }
            await recordResult(this.db, this.crawlId, r.id, commit.token, result);
          }
        } catch (e) {
          if (!(e instanceof ClaimLostError)) throw e;
          this.log("crawl.claim_lost", { crawlId: this.crawlId, url: r.url });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.throttle.max, batch.length) }, lane));
    if (failed) throw failed;
    return halted;
  }

  /**
   * Gzip the raw HTML to the blob store before the result is recorded. A failed write is retried once; a second failure
   * is logged and returns null, which the snapshot records as blob_status "blob_missing".
   */
  private async storeHtml(r: ReservedUrl, html: string): Promise<string | null> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await putRawHtml(this.blobs, this.crawlId, r.id, html);
      } catch (e) {
        this.log("crawl.blob_error", { crawlId: this.crawlId, url: r.url, attempt, message: (e as Error)?.message ?? String(e) });
        if (attempt === 2) return null;
      }
    }
  }

  /** Request a committed URL (the caller holds a throttle slot, which this returns) and classify the response. */
  private async fetchOne(r: ReservedUrl, token: string, slot: string): Promise<UrlResult | { requeue: string }> {
    const maxBytes = this.opts.fetchOptions?.maxBytes ?? V2_MAX_HTML_BYTES;
    for (let retries = 0; ; retries++) {
      let res: FetchResult;
      try {
        res = await this.request(r.url, { accept: "html", followRedirects: false, maxBytes }, slot);
      } catch (e) {
        // Stopped mid-request: it may have reached the server, so it is not retried.
        if (this.opts.signal?.aborted) return { state: "interrupted", reason: INTERRUPTED_REASON };
        if (this.fetchSignal.aborted) return { state: "cancelled", reason: "The crawl was cancelled while this request was in flight; the response was not read." };
        return failure(e);
      }
      if ((res.status !== 429 && res.status !== 503) || retries >= MAX_THROTTLE_RETRIES) return this.classify(r, res, retries);
      const wait = parseRetryAfter(res.headers["retry-after"]);
      if (wait !== null && wait > RETRY_WAIT_CAP_MS) {
        return this.classify(r, res, retries, `Retry-After asks for ${Math.round(wait / 1000)} s, longer than the ${RETRY_WAIT_CAP_MS / 1000} s this crawl waits; not retried.`);
      }
      try {
        slot = await this.throttle.acquire(this.signal); // waits out the backoff the 429/503 just set
      } catch (e) {
        if (!this.signal.aborted) throw e;
        // The server refused this request, so it is safe to send again: back to the frontier for the resume.
        const why = this.opts.signal?.aborted ? "the worker stopped" : this.fetchSignal.aborted ? "the crawl was cancelled" : "the crawl was paused";
        return { requeue: `HTTP ${res.status}, and ${why} before the retry; requested again on resume.` };
      }
      try {
        await recordRetry(this.db, r.id, token);
      } catch (e) {
        await this.throttle.release(slot);
        throw e;
      }
    }
  }

  private classify(r: ReservedUrl, res: FetchResult, retries: number, note?: string): UrlResult {
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

    const snapshot: SnapshotRow = {
      requestedUrl: r.url,
      finalUrl: res.finalUrl,
      statusCode: res.status,
      contentType: res.contentType,
      headers: res.headers,
      bytes: res.bytes,
      truncated: res.truncated,
      elapsedMs: res.elapsedMs,
      contentHash: res.body ? createHash("sha256").update(res.body).digest("hex") : null,
      outlinkCount: 0,
      rawHtmlKey: null,
      blobStatus: null,
      extracted: null,
      extractMs: 0,
    };
    const ok = res.status >= 200 && res.status < 300;
    if (ok && !res.contentTypeAccepted) {
      return { ...base, state: "non_html", reason: `Content-Type ${res.contentType || "(none)"} is not HTML.`, snapshot };
    }
    if (!ok) {
      const tries = retries ? ` after ${retries + 1} requests` : "";
      return { ...base, state: "fetched", reason: `HTTP ${res.status}${tries}${note ? `. ${note}` : ""}`, snapshot };
    }

    const $ = parseHtml(res.body);
    const out = extractOutlinks($, res.finalUrl);
    const started = performance.now();
    snapshot.extracted = extractHtml({ $, html: res.body, pageUrl: res.finalUrl, headers: res.headers, bytes: res.bytes, outlinks: out.links });
    snapshot.extractMs = Math.round((performance.now() - started) * 100) / 100;
    const childDepth = (r.depth ?? 0) + 1; // a sitemap-only page counts as depth 0 for its children
    const newUrls = out.links.map((l) => this.newUrl(l.url, l.original, l.via, childDepth));
    const edges: Edge[] = out.links.map((l) => ({ fromUrl: r.url, toUrl: l.url, via: l.via, anchor: l.anchor, rel: l.rel || null, location: l.location, nofollow: l.nofollow }));
    snapshot.outlinkCount = out.links.length;
    if (res.truncated) {
      return { ...base, state: "oversized", reason: `HTML larger than the ${res.bytes}-byte cap; the first ${res.bytes} bytes were read.`, snapshot, rawHtml: res.body, newUrls, edges };
    }
    return { ...base, state: "fetched", reason: `HTTP ${res.status}`, snapshot, rawHtml: res.body, newUrls, edges };
  }

  // ---------- endings ----------

  /** The crawl cannot run as configured: record why (shown on the audit) and settle every URL. Nothing was fetched. */
  private async finishFailed(error: { code: string; message: string }): Promise<RunOutcome> {
    const at = new Date().toISOString();
    const failed = await this.db.execute(sql`update crawls set status = 'failed', error = ${JSON.stringify({ ...error, at })}::jsonb, finished_at = now()
      where id = ${this.crawlId}::uuid and status not in ('completed', 'cancelled', 'failed') returning id`);
    if (failed.rows.length) await finalizeUrls(this.db, this.crawlId, "failed", this.crawl.max_depth, this.crawl.budget);
    this.log("crawl.failed", { crawlId: this.crawlId, ...error });
    return "failed";
  }

  private async finishCompleted(): Promise<RunOutcome> {
    let stop = await this.checkStop();
    if (stop) return stop;
    const probed = await runProbes({
      db: this.db,
      crawlId: this.crawlId,
      origin: this.crawl.site_origin,
      existing: this.crawl.probes ?? [],
      acquire: () => this.throttle.acquire(this.signal),
      release: (slot) => this.throttle.release(slot),
      request: (url, o, slot) => this.request(url, o, slot),
      peerCert: this.opts.peerCert,
      robotsToken: ROBOTS_TOKEN,
      robotsBlocked: (url, asOwnHost = false) => {
        if (!asOwnHost && new URL(url).host !== this.host) return null;
        if (this.robotsRecord?.outcome === "disallow_all") return this.robotsRecord.reason ?? "robots.txt disallows everything";
        const d = this.robots ? isAllowed(this.robots, ROBOTS_TOKEN, url) : null;
        return d && !d.allowed ? `${d.matchedRule ?? "rule"} applies to ${ROBOTS_TOKEN}` : null;
      },
      signal: this.signal,
      log: this.log,
    });
    stop = await this.checkStop();
    if (stop) return stop;
    if (!probed) return "shutdown";
    const checked = await runResources({
      db: this.db,
      crawlId: this.crawlId,
      origin: this.crawl.site_origin,
      existing: this.crawl.resources,
      throttle: (host) => (host === this.host ? this.throttle : new HostThrottle(this.opts.redis, host, this.opts.politeness)),
      send: (url, o, throttle, slot) => this.request(url, o, slot, throttle),
      robotsBlockedOwn: (url) => {
        if (this.robotsRecord?.outcome === "disallow_all") return this.robotsRecord.reason ?? "robots.txt disallows everything";
        const d = this.robots ? isAllowed(this.robots, ROBOTS_TOKEN, url) : null;
        return d && !d.allowed ? `${d.matchedRule ?? "rule"} applies to ${ROBOTS_TOKEN}` : null;
      },
      robotsToken: ROBOTS_TOKEN,
      signal: this.signal,
      log: this.log,
      limits: this.opts.resourceLimits,
    });
    stop = await this.checkStop();
    if (stop) return stop;
    if (!checked) return "shutdown";
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
    e.code === "TIMEOUT" ? "failed_timeout" : e.code === "DNS_FAILED" ? "failed_dns" : e.code === "TLS" ? "failed_tls" : "failed_network";
  return { state, reason: `${e.code}: ${e.message}` };
}
