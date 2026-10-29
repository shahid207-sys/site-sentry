import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { testRedis } from "@/test/redis";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { createSafeFetch } from "@/lib/fetch/safe-fetch";
import { isBlockedIp } from "@/lib/fetch/ip-guard";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getRawHtml, LocalBlobStore, type BlobStore } from "@/lib/snapshot/blob-store";
import { gunzipSync } from "node:zlib";
import { activeCount, cdnManagedLinks, stateCounts } from "./frontier";
import { HostThrottle, type ThrottleOptions } from "./politeness";
import { isTwinOrigin, MAX_THROTTLE_RETRIES, runCrawl, V2_USER_AGENT, type RunnerOptions, type StartRedirect } from "./runner";
import { workerFetchPolicy } from "./fetch-policy";
import { LOCAL_HOSTS_ENV, startFixtureSite } from "../../../../fixtures/site/server";
import type { ProbeRecord } from "@/lib/rules/probe-types";
import { runProbes, type ProbeContext } from "./probes";

const db = testDb();
const redis = testRedis();
afterAll(async () => {
  await db.$client.end();
  await redis.quit();
});

let srv: LocalServer;
beforeEach(async () => {
  srv = await startLocalServer();
});
afterEach(async () => {
  await srv.close();
});

const page = (links: string[], title = "page") => send(`<!doctype html><html><head><title>${title}</title></head><body><main>${links.map((l) => `<a href="${l}">${l}</a>`).join("")}</main></body></html>`);
const urlset = (urls: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;

// Each test gets its own Redis keys, so host state left by another test (same port, earlier run) cannot leak in.
let keyPrefix = "";
beforeEach(() => {
  keyPrefix = `test:runner:${randomUUID()}:`;
});
const opts = (over: Partial<RunnerOptions> = {}): RunnerOptions => ({ db, redis, politeness: { keyPrefix }, fetch: srv.fetch, owner: "test", leaseMs: 30_000, ...over });
const hostThrottle = (o: ThrottleOptions) => new HostThrottle(redis, new URL(srv.origin).host, { keyPrefix, ...o });
const oneAtATime = () => hostThrottle({ maxConcurrency: 1, ratePerSecond: 1000 });

async function urlStates(crawlId: string) {
  const r = await db.execute(sql`select normalised_url as url, state, reason, depth, discovered_via from crawl_urls where crawl_id = ${crawlId}::uuid order by id`);
  const out: Record<string, { state: string; reason: string | null; depth: number | null; via: string[] }> = {};
  for (const row of r.rows as { url: string; state: string; reason: string | null; depth: number | null; discovered_via: string[] }[]) {
    out[row.url.replace(srv.origin, "")] = { state: row.state, reason: row.reason, depth: row.depth, via: row.discovered_via };
  }
  return out;
}

// Crawl-level probes (favicon, llms.txt, og:image) are not crawl URLs and are not charged to the budget.
const PROBE_PATHS = new Set(["/favicon.ico", "/llms.txt", "/.env", "/.git/HEAD"]);
const pageHits = () => [...srv.hits.entries()].filter(([p]) => p !== "/robots.txt" && !p.endsWith(".xml") && !PROBE_PATHS.has(p));
const expectNoDuplicateFetches = () => {
  for (const [path, n] of srv.hits) expect(n, `${path} requested ${n} times`).toBe(1);
};

function smallSite() {
  const o = srv.origin;
  srv.routes.set("/robots.txt", send(`User-agent: *\nDisallow: /private/\n\nUser-agent: GPTBot\nDisallow: /\n\nSitemap: ${o}/sitemap.xml\n`, "text/plain"));
  srv.routes.set("/sitemap.xml", send(urlset([`${o}/`, `${o}/sitemap-only`, `${o}/private/listed`]), "application/xml"));
  srv.routes.set("/", page(["/a", "/private/secret", "https://other.test/x", "/old", "/file.pdf", "/missing"], "home"));
  srv.routes.set("/a", page(["/a/b"]));
  srv.routes.set("/a/b", page(["/a/b/c"]));
  srv.routes.set("/a/b/c", page(["/a/b/c/d"]));
  srv.routes.set("/a/b/c/d", page([]));
  srv.routes.set("/old", send("", "text/html", 301, { location: "/new" }));
  srv.routes.set("/new", page([]));
  srv.routes.set("/file.pdf", send("%PDF-1.4", "application/pdf"));
  srv.routes.set("/sitemap-only", page(["/from-sitemap-page"]));
  srv.routes.set("/from-sitemap-page", page([]));
}

describe("runCrawl", () => {
  it("crawls a site to completion: every URL terminal with a reason, nothing requested twice", async () => {
    smallSite();
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", maxDepth: 3 });
    expect(await runCrawl(opts(), c)).toBe("completed");

    const s = await urlStates(c);
    expect(s["/"]).toMatchObject({ state: "fetched", depth: 0, via: ["seed", "sitemap"] });
    expect(s["/a/b/c"]).toMatchObject({ state: "fetched", depth: 3 });
    expect(s["/a/b/c/d"]).toMatchObject({ state: "depth_exceeded", depth: 4 });
    expect(s["/private/secret"]).toMatchObject({ state: "blocked_robots" });
    expect(s["/private/secret"].reason).toMatch(/Disallow: \/private\//);
    expect(s["/private/listed"]).toMatchObject({ state: "blocked_robots", via: ["sitemap"] });
    expect(s["https://other.test/x"]).toMatchObject({ state: "out_of_scope" });
    expect(s["/old"]).toMatchObject({ state: "redirected", reason: `HTTP 301 → ${srv.origin}/new` });
    expect(s["/new"]).toMatchObject({ state: "fetched", depth: 1, via: ["redirect"] });
    expect(s["/file.pdf"]).toMatchObject({ state: "non_html" });
    expect(s["/missing"]).toMatchObject({ state: "fetched", reason: "HTTP 404" });
    expect(s["/sitemap-only"]).toMatchObject({ state: "fetched", depth: null, via: ["sitemap"] });
    // Linked only from a sitemap-only page: fetched, but no link path from the start URL reaches it.
    expect(s["/from-sitemap-page"]).toMatchObject({ state: "fetched", depth: null, via: ["link"] });

    expect(await activeCount(db, c)).toEqual({ discovered: 0, queued: 0, fetching: 0 });
    expectNoDuplicateFetches();
    expect(srv.hits.has("/private/secret")).toBe(false);
    expect(srv.hits.has("/a/b/c/d")).toBe(false);

    const crawl = (await db.execute(sql`select status, robots, discovery_done, fetches_committed from crawls where id = ${c}::uuid`)).rows[0] as {
      status: string;
      robots: { outcome: string; sitemaps: string[] };
      discovery_done: boolean;
      fetches_committed: number;
    };
    expect(crawl).toMatchObject({ status: "completed", discovery_done: true, robots: { outcome: "parsed", sitemaps: [`${srv.origin}/sitemap.xml`] } });
    expect(crawl.fetches_committed).toBe(pageHits().length);
    const edges = await db.execute(sql`select count(*)::int as n from url_edges where crawl_id = ${c}::uuid and via = 'redirect'`);
    expect((edges.rows[0] as { n: number }).n).toBe(1);
  });

  it("writes the full page snapshot and gzips the raw HTML to the blob store", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runner-blobs-"));
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Snap</title><meta name="description" content="Desc">
      <link rel="canonical" href="${srv.origin}/"></head><body><main><h1>Head</h1><p>Body text</p><img src="/i.png" alt="x"></main></body></html>`;
    srv.routes.set("/", send(html, "text/html; charset=utf-8", 200, { "x-robots-tag": "noarchive" }));
    srv.routes.set("/gone", send("", "text/html", 404));
    srv.routes.set("/i.png", send("png", "image/png"));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", config: { seeds: [`${srv.origin}/`, `${srv.origin}/gone`] } });
    const blobs = new LocalBlobStore(dir);
    try {
      expect(await runCrawl(opts({ blobs }), c)).toBe("completed");
      const r = await db.execute(sql`select s.*, u.normalised_url from page_snapshots s join crawl_urls u on u.id = s.url_id where s.crawl_id = ${c}::uuid order by s.status_code`);
      const [home, gone] = r.rows as Record<string, unknown>[];
      expect(home).toMatchObject({
        requested_url: `${srv.origin}/`,
        status_code: 200,
        title: "Snap",
        titles: ["Snap"],
        description: "Desc",
        outline: [{ level: 1, text: "Head" }],
        main_text: "Head Body text",
        word_count: 3,
        canonicals: [{ resolved: `${srv.origin}/`, location: "head", absolute: true }],
        images: [{ resolved: `${srv.origin}/i.png`, alt: "x" }],
        robots: { noindex: { meta: false, header: false } },
      });
      expect((home.timings as { extractMs: number }).extractMs).toBeGreaterThanOrEqual(0);
      expect(home.raw_html_key).toBe(`crawls/${c}/html/${home.url_id}.html.gz`);
      expect(home.blob_status).toBe("stored");
      expect(await getRawHtml(blobs, home.raw_html_key as string)).toBe(html);
      // A 404 has no body: its snapshot keeps the response, with no extraction and no blob.
      expect(gone).toMatchObject({ status_code: 404, raw_html_key: null, blob_status: null, title: null, facts: null, titles: [] });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("retries a failed blob write once; a second failure leaves the snapshot blob_missing, never a silent null", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "runner-blobs-"));
    const real = new LocalBlobStore(dir);
    // /flaky fails its first write only; /broken fails every write.
    const failures = new Map<string, number>(); // write attempts per tagged page
    const blobs: BlobStore = {
      getObject: (k) => real.getObject(k),
      headObject: (k) => real.headObject(k),
      deleteObject: (k) => real.deleteObject(k),
      putObject: async (input) => {
        const html = gunzipSync(input.Body as Buffer).toString();
        const tag = html.includes("<title>broken</title>") ? "broken" : html.includes("<title>flaky</title>") ? "flaky" : null;
        const n = tag ? (failures.get(tag) ?? 0) + 1 : 0;
        if (tag) failures.set(tag, n);
        if (tag === "broken" || (tag === "flaky" && n === 1)) throw new Error(`disk full (${tag}, write ${n})`);
        return real.putObject(input);
      },
    };
    srv.routes.set("/", page(["/flaky", "/broken"], "home"));
    srv.routes.set("/flaky", page([], "flaky"));
    srv.routes.set("/broken", page([], "broken"));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    try {
      expect(await runCrawl(opts({ blobs }), c)).toBe("completed");
      const rows = (await db.execute(sql`select s.title, s.raw_html_key, s.blob_status from page_snapshots s where s.crawl_id = ${c}::uuid order by s.title`)).rows;
      expect(rows).toEqual([
        { title: "broken", raw_html_key: null, blob_status: "blob_missing" },
        { title: "flaky", raw_html_key: expect.stringMatching(/\.html\.gz$/), blob_status: "stored" },
        { title: "home", raw_html_key: expect.stringMatching(/\.html\.gz$/), blob_status: "stored" },
      ]);
      expect(Object.fromEntries(failures)).toEqual({ flaky: 2, broken: 2 }); // write attempts: the first and one retry, never a third
      // The page itself is still recorded and checked as fetched.
      expect((await stateCounts(db, c)).fetched).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("stops at the budget and files the rest as budget_exhausted", async () => {
    smallSite();
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", budget: 3, maxDepth: 10 });
    expect(await runCrawl(opts(), c)).toBe("completed");
    const counts = await stateCounts(db, c);
    expect(pageHits()).toHaveLength(3);
    expect(counts.budget_exhausted).toBeGreaterThan(0);
    expect(await activeCount(db, c)).toEqual({ discovered: 0, queued: 0, fetching: 0 });
    expectNoDuplicateFetches();
  });

  it("records CDN-injected paths (/cdn-cgi/…) as cdn_managed without requesting them, and counts the links", async () => {
    const o = srv.origin;
    srv.routes.set("/", page([`${o}/cdn-cgi/l/email-protection#6a0b0e07`, `${o}/cdn-cgi/trace`, `${o}/a`]));
    srv.routes.set("/a", page([`${o}/cdn-cgi/l/email-protection#0e07`, `${o}/cdn-cgi-docs`]));
    srv.routes.set("/cdn-cgi-docs", page([]));
    const c = await newCrawl(db, { siteOrigin: o, status: "queued", maxDepth: 10 });
    expect(await runCrawl(opts(), c)).toBe("completed");
    const s = await urlStates(c);
    expect(s["/cdn-cgi/l/email-protection"]).toMatchObject({ state: "cdn_managed", reason: expect.stringMatching(/^Cloudflare-managed path/) });
    expect(s["/cdn-cgi/trace"].state).toBe("cdn_managed");
    expect(s["/cdn-cgi-docs"].state).toBe("fetched"); // a prefix of the path segment, not the CDN directory
    expect([...srv.hits.keys()].filter((p) => p.startsWith("/cdn-cgi/"))).toEqual([]);
    expect(await cdnManagedLinks(db, c)).toEqual({ urls: 2, links: 3, pages: 2 });
  });

  it("treats a 5xx robots.txt as a full disallow (RFC 9309) and fetches no pages", async () => {
    srv.routes.set("/robots.txt", send("down", "text/plain", 503));
    srv.routes.set("/", page(["/a"]));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    expect(await runCrawl(opts(), c)).toBe("completed");
    expect((await urlStates(c))["/"]).toMatchObject({ state: "blocked_robots" });
    expect(pageHits()).toHaveLength(0);
  });

  it("pauses before the next request, then resumes without re-requesting anything", async () => {
    smallSite();
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", maxDepth: 10 });
    srv.routes.set("/a", (req, res) => {
      void db.execute(sql`update crawls set status = 'paused' where id = ${c}::uuid`).then(() => page(["/a/b"])(req, res));
    });
    expect(await runCrawl(opts({ throttle: oneAtATime() }), c)).toBe("paused");
    const mid = await activeCount(db, c);
    expect(mid.queued + mid.fetching).toBe(0);
    expect(mid.discovered).toBeGreaterThan(0);
    // Paused runs do nothing.
    expect(await runCrawl(opts(), c)).toBe("paused");

    await db.execute(sql`update crawls set status = 'running' where id = ${c}::uuid`);
    expect(await runCrawl(opts(), c)).toBe("completed");
    expect(await activeCount(db, c)).toEqual({ discovered: 0, queued: 0, fetching: 0 });
    expectNoDuplicateFetches();
  });

  it("cancels: in-flight work finishes, everything left becomes cancelled", async () => {
    smallSite();
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", maxDepth: 10 });
    srv.routes.set("/a", (req, res) => {
      void db.execute(sql`update crawls set status = 'cancelling' where id = ${c}::uuid`).then(() => page(["/a/b"])(req, res));
    });
    expect(await runCrawl(opts({ throttle: oneAtATime() }), c)).toBe("cancelled");
    const counts = await stateCounts(db, c);
    expect(counts.cancelled).toBeGreaterThan(0);
    expect(await activeCount(db, c)).toEqual({ discovered: 0, queued: 0, fetching: 0 });
    const status = await db.execute(sql`select status from crawls where id = ${c}::uuid`);
    expect((status.rows[0] as { status: string }).status).toBe("cancelled");
    expectNoDuplicateFetches();
  });

  it("allows one runner per crawl", async () => {
    smallSite();
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", maxDepth: 10 });
    const outcomes = await Promise.all([runCrawl(opts(), c), runCrawl(opts(), c)]);
    expect(outcomes.sort()).toEqual(["completed", "locked"]);
    expectNoDuplicateFetches();
  });
});

describe("runCrawl politeness", () => {
  async function urlRow(crawlId: string, path: string) {
    const r = await db.execute(sql`select state, reason, status_code, attempts from crawl_urls where crawl_id = ${crawlId}::uuid and normalised_url = ${srv.origin + path}`);
    return r.rows[0] as { state: string; reason: string; status_code: number; attempts: number };
  }

  it("prunes the host's throttle state from Redis when the crawl ends", async () => {
    srv.routes.set("/", page(["/a", "/b"]));
    srv.routes.set("/a", page([]));
    srv.routes.set("/b", page([]));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    const throttle = hostThrottle({ ratePerSecond: 1000 }); // 1 ms spacing, so nothing holds the host at the end
    expect(await runCrawl(opts({ throttle }), c)).toBe("completed");
    expect(await redis.keys(`${keyPrefix}*`)).toEqual([]);

    // A crawl that is still running on the host keeps the state for itself.
    await throttle.attach("another-crawl");
    const c2 = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    expect(await runCrawl(opts({ throttle }), c2)).toBe("completed");
    expect(await redis.smembers(throttle.redisKeys[3])).toEqual(["another-crawl"]);
    expect(await redis.pttl(throttle.redisKeys[0])).toBeGreaterThan(0);
  });

  it("keeps at most 3 requests in flight per host and sends the spec user-agent", async () => {
    let inFlight = 0;
    let peak = 0;
    const agents = new Set<string>();
    const kids = Array.from({ length: 24 }, (_, i) => `/k/${i}`);
    srv.routes.set("/robots.txt", send("User-agent: *\nDisallow:\n", "text/plain"));
    srv.routes.set("/", page(kids));
    for (const k of kids) {
      srv.routes.set(k, (req, res) => {
        agents.add(String(req.headers["user-agent"]));
        peak = Math.max(peak, ++inFlight);
        setTimeout(() => {
          inFlight--;
          page([])(req, res);
        }, 40);
      });
    }
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    // A fast rate so the in-flight cap, not the 5 req/s spacing, is what limits this crawl.
    expect(await runCrawl(opts({ throttle: hostThrottle({ ratePerSecond: 1000 }) }), c)).toBe("completed");
    expect(peak).toBe(3);
    expect([...agents]).toEqual([V2_USER_AGENT]);
    expectNoDuplicateFetches();
  });

  it("spaces requests by 5 req/s by default", async () => {
    const starts: number[] = [];
    const kids = Array.from({ length: 5 }, (_, i) => `/k/${i}`);
    srv.routes.set("/", page(kids));
    for (const k of kids) srv.routes.set(k, (req, res) => (starts.push(Date.now()), page([])(req, res)));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    expect(await runCrawl(opts(), c)).toBe("completed");
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(190); // 200 ms, less timer slack
  });

  it("honours Crawl-delay for SiteSentryBot", async () => {
    const starts: number[] = [];
    srv.routes.set("/robots.txt", send("User-agent: SiteSentryBot\nCrawl-delay: 0.6\n\nUser-agent: *\nCrawl-delay: 0\n", "text/plain"));
    srv.routes.set("/", (req, res) => (starts.push(Date.now()), page(["/a", "/b"])(req, res)));
    for (const k of ["/a", "/b"]) srv.routes.set(k, (req, res) => (starts.push(Date.now()), page([])(req, res)));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    const throttle = hostThrottle({ ratePerSecond: 1000 });
    expect(await runCrawl(opts({ throttle }), c)).toBe("completed");
    expect(throttle.intervalMs).toBe(600);
    const gaps = starts.slice(1).map((t, i) => t - starts[i]);
    expect(gaps).toHaveLength(2);
    // The throttle spaces slot grants exactly (politeness.int.test.ts); each request then waits one Postgres commit
    // before it is sent, so the gaps seen by the server vary by that commit's latency.
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(500);
  });

  it("retries a 429 after its Retry-After, slows the host down, and counts both requests", async () => {
    const starts: number[] = [];
    srv.routes.set("/", page(["/busy"]));
    srv.routes.set("/busy", (req, res) => {
      starts.push(Date.now());
      if (starts.length === 1) return void res.writeHead(429, { "content-type": "text/html", "retry-after": "1" }).end("slow down");
      page([])(req, res);
    });
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    const throttle = hostThrottle({ ratePerSecond: 1000, baseBackoffMs: 100 });
    expect(await runCrawl(opts({ throttle }), c)).toBe("completed");
    expect(await urlRow(c, "/busy")).toMatchObject({ state: "fetched", status_code: 200, reason: "HTTP 200", attempts: 2 });
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(990); // Retry-After: 1, longer than the 100 ms backoff
    expect(throttle.events).toMatchObject([{ reason: "429", concurrency: 1, pausedForMs: 1000 }]);
  });

  it(`gives up after ${MAX_THROTTLE_RETRIES} retries and files the 429 as the result`, async () => {
    srv.routes.set("/", page(["/busy"]));
    srv.routes.set("/busy", send("busy", "text/html", 429)); // no Retry-After: exponential backoff
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    const throttle = hostThrottle({ ratePerSecond: 1000, baseBackoffMs: 20 });
    expect(await runCrawl(opts({ throttle }), c)).toBe("completed");
    expect(await urlRow(c, "/busy")).toMatchObject({ state: "fetched", status_code: 429, reason: "HTTP 429 after 3 requests", attempts: 3 });
    expect(srv.hits.get("/busy")).toBe(MAX_THROTTLE_RETRIES + 1);
    expect(throttle.events.map((e) => e.pausedForMs)).toEqual([20, 40, 80]); // exponential
  });

  it("does not retry when Retry-After asks for longer than the cap", async () => {
    srv.routes.set("/", page(["/down"]));
    srv.routes.set("/down", send("maintenance", "text/html", 503, { "retry-after": "3600" }));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    // The host pause is capped at maxBackoffMs (60 s by default; 50 ms here to keep the test fast).
    const throttle = hostThrottle({ ratePerSecond: 1000, baseBackoffMs: 20, maxBackoffMs: 50 });
    expect(await runCrawl(opts({ throttle }), c)).toBe("completed");
    const row = await urlRow(c, "/down");
    expect(row).toMatchObject({ state: "fetched", status_code: 503, attempts: 1 });
    expect(row.reason).toBe("HTTP 503. Retry-After asks for 3600 s, longer than the 60 s this crawl waits; not retried.");
    expect(srv.hits.get("/down")).toBe(1);
    expect(throttle.events).toMatchObject([{ reason: "503", pausedForMs: 50 }]);
  });

  it("halves concurrency when p95 latency goes over the threshold", async () => {
    const kids = Array.from({ length: 12 }, (_, i) => `/k/${i}`);
    srv.routes.set("/", page(kids));
    for (const k of kids) srv.routes.set(k, (req, res) => void setTimeout(() => page([])(req, res), 60));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    // Thresholds scaled down (3 s → 30 ms, window 20 → 4) so the test runs in milliseconds, not minutes.
    const throttle = hostThrottle({ ratePerSecond: 1000, slowP95Ms: 30, window: 4, baseBackoffMs: 10 });
    expect(await runCrawl(opts({ throttle }), c)).toBe("completed");
    expect(throttle.events.map((e) => e.reason)).toContain("slow_p95");
    expect(throttle.events[0].concurrency).toBe(1);
    expectNoDuplicateFetches();
  });
});

describe("runCrawl Custom profile scope and auth", () => {
  const fast = () => hostThrottle({ ratePerSecond: 1000 });

  it("keeps to the subfolder (out_of_scope) and applies exclude rules (excluded_by_rule)", async () => {
    srv.routes.set("/blog/", page(["/blog/a", "/blog/drafts/x", "/shop/", "/"]));
    srv.routes.set("/blog/a", page([]));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", config: { scope: { include: [], exclude: ["/drafts/"], subfolder: "/blog/" } } });
    expect(await runCrawl(opts({ throttle: fast() }), c)).toBe("completed");
    const s = await urlStates(c);
    expect(s["/blog/"]).toMatchObject({ state: "fetched", via: ["seed"] }); // the subfolder is the default start URL
    expect(s["/blog/a"]).toMatchObject({ state: "fetched" });
    expect(s["/blog/drafts/x"]).toMatchObject({ state: "excluded_by_rule", reason: 'Matches the exclude rule "/drafts/".' });
    expect(s["/shop/"]).toMatchObject({ state: "out_of_scope", reason: "Outside /blog/; this crawl covers only that subfolder." });
    expect(s["/"]).toMatchObject({ state: "out_of_scope" });
    expect(srv.hits.has("/robots.txt")).toBe(true); // robots.txt is still read at the root
    expect(srv.hits.has("/shop/")).toBe(false);
    expect(srv.hits.has("/blog/drafts/x")).toBe(false);
  });

  it("with include rules, crawls only matching URLs (tested against the normalised URL)", async () => {
    srv.routes.set("/", page(["/en/a", "/en/b", "/fr/a"]));
    for (const p of ["/en/a", "/en/b"]) srv.routes.set(p, page([]));
    // "/" or anything under /en/. Written as an alternation: (en/.*)? would be refused (an optional group around .*).
    const include = [`^${srv.origin.replace(/\./g, "\\.")}/($|en/)`];
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", config: { scope: { include, exclude: [] } } });
    expect(await runCrawl(opts({ throttle: fast() }), c)).toBe("completed");
    const s = await urlStates(c);
    expect(s["/"].state).toBe("fetched");
    expect(s["/en/a"].state).toBe("fetched");
    expect(s["/fr/a"]).toMatchObject({ state: "excluded_by_rule", reason: "Matches none of the 1 include rule(s)." });
    expect(srv.hits.has("/fr/a")).toBe(false);
  });

  it("sends basic auth to the crawl's origin only, decrypted from crawls.config", async () => {
    const { randomBytes, randomUUID } = await import("node:crypto");
    const { crawlSecretScope, encryptSecret } = await import("./secrets");
    const key = randomBytes(32);
    const other = await startLocalServer();
    const seen = new Map<string, string | undefined>();
    const guarded = (body: string) => (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => {
      seen.set(`${req.headers.host}${req.url}`, req.headers.authorization);
      if (req.headers.authorization !== `Basic ${Buffer.from("stage:s3cret").toString("base64")}`) return void res.writeHead(401, { "content-type": "text/html" }).end("auth");
      page([body])(req, res);
    };
    srv.routes.set("/", guarded("/inner"));
    srv.routes.set("/inner", guarded("/"));
    other.routes.set("/sitemap.xml", (req, res) => {
      seen.set(`other${req.url}`, req.headers.authorization);
      send(urlset([`${srv.origin}/inner`]), "application/xml")(req, res);
    });
    const id = randomUUID();
    const config = { sitemaps: [`${other.origin}/sitemap.xml`], auth: { username: "stage", password: encryptSecret("s3cret", key, crawlSecretScope(id)) } };
    await newCrawl(db, { id, siteOrigin: srv.origin, status: "queued", config });
    // Both servers are on 127.0.0.1 with their own ports; this fetcher may reach either.
    const { createSafeFetch } = await import("@/lib/fetch/safe-fetch");
    const fetch = createSafeFetch({ resolve: async () => ["127.0.0.1"], isBlocked: () => false, allowedPorts: new Set([String(srv.port), String(other.port)]), allowLocalNames: false });
    process.env.CRAWLER_SECRET_KEY = key.toString("base64");
    try {
      expect(await runCrawl(opts({ fetch, throttle: fast() }), id)).toBe("completed");
    } finally {
      delete process.env.CRAWLER_SECRET_KEY;
      await other.close();
    }
    const s = await urlStates(id);
    expect(s["/"]).toMatchObject({ state: "fetched", reason: "HTTP 200" });
    expect(s["/inner"]).toMatchObject({ state: "fetched", reason: "HTTP 200" });
    expect(seen.get("other/sitemap.xml")).toBeUndefined(); // credentials never left the crawl's origin
    const row = (await db.execute(sql`select config::text as c from crawls where id = ${id}::uuid`)).rows[0] as { c: string };
    expect(row.c).not.toContain("s3cret");
  });

  it("a stored scope rule that is now refused fails the crawl with scope_rule_invalid, without fetching or throwing", async () => {
    srv.routes.set("/", page(["/a"]));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", config: { scope: { include: [], exclude: ["/ok/", "(a+)+$"] } } });
    expect(await runCrawl(opts({ throttle: fast() }), c)).toBe("failed");
    expect(srv.hits.size).toBe(0);
    const row = (await db.execute(sql`select status, error, finished_at from crawls where id = ${c}::uuid`)).rows[0] as { status: string; error: { code: string; message: string }; finished_at: unknown };
    expect(row.status).toBe("failed");
    expect(row.error).toMatchObject({ code: "scope_rule_invalid", message: expect.stringMatching(/^Exclude rule 2 "\(a\+\)\+\$" is refused: Refused: .* Edit the rule and start a new audit\.$/) });
    expect(row.finished_at).not.toBeNull();
    expect(await activeCount(db, c)).toMatchObject({ queued: 0, fetching: 0, discovered: 0 });
    expect(await runCrawl(opts({ throttle: fast() }), c)).toBe("not_runnable"); // never retried
  });

  it("fails the crawl with a clear error when the worker has no CRAWLER_SECRET_KEY", async () => {
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", config: { auth: { username: "u", password: "v1.a.b.c" } } });
    await expect(runCrawl(opts({ throttle: fast() }), c)).rejects.toThrow("CRAWLER_SECRET_KEY is not set on the worker");
    expect(srv.hits.size).toBe(0);
  });
});

describe("runCrawl pause and cancel take effect within 2 s", () => {
  const fast = () => hostThrottle({ ratePerSecond: 1000 }); // spec backoff: a 503 with Retry-After holds the host for up to 60 s
  const row = async (crawlId: string, path: string) =>
    (await db.execute(sql`select state, reason from crawl_urls where crawl_id = ${crawlId}::uuid and normalised_url = ${srv.origin + path}`)).rows[0] as { state: string; reason: string };
  const setStatus = (c: string, status: string) => db.execute(sql`update crawls set status = ${status} where id = ${c}::uuid`);
  const until = async (cond: () => boolean) => {
    while (!cond()) await new Promise((r) => setTimeout(r, 10));
  };
  /**
   * /busy answers 503 with Retry-After: 50, so its lane waits 50 s for the retry. /x is linked from /a (fetched
   * alongside /busy), so it can only be claimed in the next batch, which waits for that retry: it is never fetched.
   */
  const heldHost = () => {
    srv.routes.set("/", page(["/busy", "/a"]));
    srv.routes.set("/busy", send("busy", "text/html", 503, { "retry-after": "50" }));
    srv.routes.set("/a", page(["/x"]));
    srv.routes.set("/x", page([]));
  };

  it("pause during a Retry-After wait: stops within 2 s and returns the refused URL to the frontier; resume fetches it", async () => {
    heldHost();
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    const run = runCrawl(opts({ throttle: fast() }), c);
    await until(() => srv.hits.get("/busy") === 1);
    await new Promise((r) => setTimeout(r, 100)); // the 503 is in; the host is now held for 50 s
    const t0 = Date.now();
    await setStatus(c, "paused");
    expect(await run).toBe("paused");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(await row(c, "/busy")).toMatchObject({ state: "discovered", reason: null });
    expect(srv.hits.get("/busy")).toBe(1);
    expect(srv.hits.has("/x")).toBe(false);
    expect(await activeCount(db, c)).toMatchObject({ queued: 0, fetching: 0, discovered: 2 }); // /busy and /x, for the resume
    const committed = async () => ((await db.execute(sql`select fetches_committed from crawls where id = ${c}::uuid`)).rows[0] as { fetches_committed: number }).fetches_committed;
    expect(await committed()).toBe(2); // / and /a; the refused /busy was refunded

    // Resume: the server has recovered (and a fresh throttle, so the 50 s host hold is not waited out here).
    srv.routes.set("/busy", page([]));
    await setStatus(c, "running");
    expect(await runCrawl(opts({ throttle: hostThrottle({ ratePerSecond: 1000, keyPrefix: `${keyPrefix}resume:` }) }), c)).toBe("completed");
    expect(await row(c, "/busy")).toMatchObject({ state: "fetched", reason: "HTTP 200" });
    expect(srv.hits.get("/busy")).toBe(2);
    expect(await committed()).toBe(4); // /, /a, /busy, /x: each URL charged once
  });

  it("cancel during a Retry-After wait: ends cancelled within 2 s", async () => {
    heldHost();
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    const run = runCrawl(opts({ throttle: fast() }), c);
    await until(() => srv.hits.get("/busy") === 1);
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await setStatus(c, "cancelling");
    expect(await run).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(await row(c, "/busy")).toMatchObject({ state: "cancelled", reason: "The crawl was cancelled before this URL was fetched." });
    expect(await row(c, "/x")).toMatchObject({ state: "cancelled" });
    expect(((await db.execute(sql`select status from crawls where id = ${c}::uuid`)).rows[0] as { status: string }).status).toBe("cancelled");
  });

  it("cancel with a request in flight: aborts it and ends cancelled within 2 s", async () => {
    srv.routes.set("/", page(["/hang"]));
    srv.routes.set("/hang", (req, res) => void setTimeout(() => !res.destroyed && page([])(req, res), 10_000));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    const run = runCrawl(opts({ throttle: fast() }), c);
    await until(() => srv.hits.get("/hang") === 1);
    const t0 = Date.now();
    await setStatus(c, "cancelling");
    expect(await run).toBe("cancelled");
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(await row(c, "/hang")).toMatchObject({ state: "cancelled", reason: "The crawl was cancelled while this request was in flight; the response was not read." });
  });

  it("pause with a request in flight: no new request starts, and the one in flight is recorded, not interrupted", async () => {
    const arrivals: [string, number][] = [];
    const kids = Array.from({ length: 6 }, (_, i) => `/k/${i}`);
    srv.routes.set("/", page(["/slow"]));
    srv.routes.set("/slow", (req, res) => (arrivals.push(["/slow", Date.now()]), void setTimeout(() => page(kids)(req, res), 1_500)));
    for (const k of kids) srv.routes.set(k, (req, res) => (arrivals.push([k, Date.now()]), void setTimeout(() => page([])(req, res), 300)));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    const run = runCrawl(opts({ throttle: oneAtATime() }), c); // /slow links the kids, which are found only after the pause
    await until(() => srv.hits.get("/slow") === 1);
    const t0 = Date.now();
    await setStatus(c, "paused");
    expect(await run).toBe("paused");
    expect(arrivals.filter(([, t]) => t > t0 + 2_000)).toEqual([]);
    expect(await row(c, "/slow")).toMatchObject({ state: "fetched", reason: "HTTP 200" });
    expect(await activeCount(db, c)).toMatchObject({ queued: 0, fetching: 0 });
    expect((await activeCount(db, c)).discovered).toBeGreaterThan(0);
  });
});

describe("runCrawl crawl-level probes", () => {
  const png = (w: number, h: number) => {
    const b = Buffer.alloc(33);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
    b.writeUInt32BE(13, 8);
    b.write("IHDR", 12, "latin1");
    b.writeUInt32BE(w, 16);
    b.writeUInt32BE(h, 20);
    return b;
  };
  const sendBytes = (buf: Buffer, type: string) => (_req: unknown, res: import("node:http").ServerResponse) => res.writeHead(200, { "content-type": type }).end(buf);

  it("probes the scheme variant, favicon, llms.txt and og:images once, outside the URL budget", async () => {
    const o = srv.origin;
    srv.routes.set("/", send(`<!doctype html><html><head><title>t</title><meta property="og:image" content="/og.png"><link rel="icon" href="/icon.png"></head><body><a href="/b">b</a></body></html>`));
    srv.routes.set("/b", send(`<!doctype html><html><head><title>b</title><meta property="og:image" content="${o}/small.png"></head><body></body></html>`));
    srv.routes.set("/og.png", sendBytes(png(1200, 630), "image/png"));
    srv.routes.set("/small.png", sendBytes(png(100, 100), "image/png"));
    srv.routes.set("/icon.png", sendBytes(png(32, 32), "image/png"));
    srv.routes.set("/llms.txt", send("# Site\n\n> Summary.\n", "text/plain"));
    const c = await newCrawl(db, { siteOrigin: o, status: "queued", budget: 2 });
    expect(await runCrawl(opts(), c)).toBe("completed");

    const row = (await db.execute(sql`select probes, fetches_committed from crawls where id = ${c}::uuid`)).rows[0] as { probes: ProbeRecord[]; fetches_committed: number };
    expect(row.fetches_committed).toBe(2); // probes are not charged to the budget
    const by = (kind: string) => row.probes.filter((p) => p.kind === kind);
    // The origin is an IP, so there is no www variant; the https variant of a plain-http test server fails.
    expect(by("home_www")).toEqual([]);
    expect(by("home_scheme")[0]).toMatchObject({ url: o.replace("http:", "https:") + "/", status: null, error: { code: expect.any(String) } });
    expect(by("favicon")[0]).toMatchObject({ url: `${o}/icon.png`, status: 200 });
    expect(by("llms_txt")[0]).toMatchObject({ status: 200, body: "# Site\n\n> Summary.\n" });
    expect(by("og_image").map((p) => [p.url, p.status, p.width, p.height])).toEqual([
      [`${o}/og.png`, 200, 1200, 630],
      [`${o}/small.png`, 200, 100, 100],
    ]);
    for (const p of ["/og.png", "/small.png", "/icon.png", "/llms.txt"]) expect(srv.hits.get(p), p).toBe(1);
  });

  it("probes /.env and /.git/HEAD, keeping only the signature match, never the body (SEC-006)", async () => {
    const CANARY = "sk_live_canary_9f3a";
    srv.routes.set("/", page([]));
    srv.routes.set("/.env", send(`# app settings\nDB_HOST=db.internal\nexport API_KEY=${CANARY}\n\nDEBUG=false\n`, "text/plain"));
    srv.routes.set("/.git/HEAD", send("ref: refs/heads/main\n", "text/plain"));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", budget: 1 });
    expect(await runCrawl(opts(), c)).toBe("completed");
    const probes = ((await db.execute(sql`select probes from crawls where id = ${c}::uuid`)).rows[0] as { probes: ProbeRecord[] }).probes;
    expect(probes.find((p) => p.kind === "env_file")).toMatchObject({ status: 200, secret: { pattern: "env_key_value", lines: 3 } });
    expect(probes.find((p) => p.kind === "git_head")).toMatchObject({ status: 200, secret: { pattern: "git_head_ref", lines: 1 } });
    expect(JSON.stringify(probes)).not.toContain(CANARY);
    expect(JSON.stringify(probes)).not.toContain("db.internal");

    // A catch-all route answering 200 with an HTML page is a soft 404, not the file.
    srv.routes.set("/.env", send("<!doctype html><title>Not found</title><p>API_KEY=nothing here</p>"));
    srv.routes.set("/.git/HEAD", send("<!doctype html><title>Home</title>"));
    const soft = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", budget: 1 });
    expect(await runCrawl(opts(), soft)).toBe("completed");
    const sp = ((await db.execute(sql`select probes from crawls where id = ${soft}::uuid`)).rows[0] as { probes: ProbeRecord[] }).probes;
    expect(sp.find((p) => p.kind === "env_file")).toMatchObject({ status: 200, secret: null });
    expect(sp.find((p) => p.kind === "git_head")).toMatchObject({ status: 200, secret: null });
  });

  it("checks external links and images within their budgets: HEAD first, GET when HEAD is refused, robots per host (LNK-010, IMG)", async () => {
    const port = srv.port;
    const o = srv.origin;
    const log: string[] = [];
    const logged = (h: import("@/test/local-server").Handler): import("@/test/local-server").Handler => (req, res) => {
      log.push(`${req.headers.host} ${req.method} ${req.url}${req.headers.range ? ` range=${req.headers.range}` : ""}`);
      h(req, res);
    };
    const ext = (host: string, i: number) => `http://${host}:${port}/x/${host.split(".")[0]}/${i}`;
    const hosts = ["ext1.test", "ext2.test", "ext3.test"];
    const links = hosts.flatMap((h) => [0, 1, 2, 3].map((i) => ext(h, i)));
    links.push(`http://blocked.test:${port}/x/blocked/0`);
    const imgs = [0, 1, 2, 3].map((i) => `${o}/img/${i}.png`);
    srv.routes.set("/", send(`<!doctype html><title>t</title><body>${links.map((l) => `<a href="${l}">x</a>`).join("")}${imgs.map((i) => `<img src="${i}" alt="">`).join("")}<a href="/b">b</a></body>`));
    srv.routes.set("/b", send(`<!doctype html><title>b</title><body><a href="${links[0]}">again</a><img src="${imgs[0]}" alt=""></body>`));
    srv.routes.set("/robots.txt", logged((req, res) => {
      const body = req.headers.host?.startsWith("blocked.test") ? "User-agent: *\nDisallow: /x/\n" : "User-agent: *\nAllow: /\n";
      res.writeHead(200, { "content-type": "text/plain" }).end(body);
    }));
    for (const l of links) {
      const p = new URL(l).pathname;
      // ext2's first URL refuses HEAD; ext3's last is gone.
      srv.routes.set(p, logged((req, res) => {
        if (p === "/x/ext2/0" && req.method === "HEAD") return void res.writeHead(405).end();
        res.writeHead(p === "/x/ext3/3" ? 404 : 200, { "content-type": "text/html" }).end(req.method === "HEAD" ? undefined : "<title>ok</title>");
      }));
    }
    const png = Buffer.alloc(200_000);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
    png.writeUInt32BE(13, 8);
    png.write("IHDR", 12, "latin1");
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(480, 20);
    for (const i of imgs) {
      srv.routes.set(new URL(i).pathname, logged((req, res) => {
        const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
        if (req.method === "HEAD") return void res.writeHead(200, { "content-type": "image/png", "content-length": png.length }).end();
        if (!m) return void res.writeHead(200, { "content-type": "image/png" }).end(png);
        const part = png.subarray(Number(m[1]), Number(m[2]) + 1);
        res.writeHead(206, { "content-type": "image/png", "content-range": `bytes ${m[1]}-${m[2]}/${png.length}` }).end(part);
      }));
    }

    const c = await newCrawl(db, { siteOrigin: o, status: "queued", budget: 5 });
    expect(await runCrawl(opts({ resourceLimits: { externalLinks: 7, images: 3 } }), c)).toBe("completed");

    const row = (await db.execute(sql`select resources, fetches_committed from crawls where id = ${c}::uuid`)).rows[0] as { resources: import("./resources").CrawlResourcesSummary; fetches_committed: number };
    expect(row.fetches_committed).toBe(2); // resources are not charged to the URL budget
    expect(row.resources).toMatchObject({ planned: true, external: { found: 13, planned: 7, overBudget: 6, budget: 7 }, images: { found: 4, planned: 3, overBudget: 1, budget: 3 } });
    expect(row.resources.finishedAt).toEqual(expect.any(String));

    const rs = (await db.execute(sql`select kind, url, state, skip_code, method, status, bytes, width, height, referrers, sample_pages from resources where crawl_id = ${c}::uuid order by id`)).rows as Record<string, unknown>[];
    const ext7 = rs.filter((r) => r.kind === "external_link");
    // Round-robin across hosts in first-seen order: one per host per turn.
    expect(ext7.map((r) => r.url)).toEqual([ext("ext1.test", 0), ext("ext2.test", 0), ext("ext3.test", 0), `http://blocked.test:${port}/x/blocked/0`, ext("ext1.test", 1), ext("ext2.test", 1), ext("ext3.test", 1)]);
    const by = (u: string) => rs.find((r) => r.url === u)!;
    expect(by(ext("ext1.test", 0))).toMatchObject({ state: "done", method: "HEAD", status: 200, referrers: 2, sample_pages: [`${o}/`, `${o}/b`] });
    expect(by(ext("ext2.test", 0))).toMatchObject({ state: "done", method: "GET", status: 200 });
    expect(by(`http://blocked.test:${port}/x/blocked/0`)).toMatchObject({ state: "skipped", skip_code: "blocked_robots", status: null });
    const img = rs.filter((r) => r.kind === "image");
    expect(img.map((r) => [r.url, r.state, r.method, r.status, Number(r.bytes), r.width, r.height])).toEqual(
      imgs.slice(0, 3).map((u) => [u, "done", "HEAD+GET", 200, 200_000, 640, 480]),
    );

    // Requests counted at the server: within budget, once each, robots.txt once per external host.
    const extRequests = log.filter((l) => / \/x\//.test(l));
    expect(extRequests.filter((l) => l.includes("/x/blocked/"))).toEqual([]);
    expect(extRequests.filter((l) => !l.includes("/x/ext2/0")).length).toBe(5); // 6 checkable links, one HEAD each…
    expect(extRequests.filter((l) => l.includes("/x/ext2/0"))).toEqual([`ext2.test:${port} HEAD /x/ext2/0`, `ext2.test:${port} GET /x/ext2/0`]); // …and HEAD then GET
    for (const h of [...hosts, "blocked.test"]) expect(log.filter((l) => l === `${h}:${port} GET /robots.txt`).length, h).toBe(1);
    const imgRequests = log.filter((l) => l.includes("/img/"));
    expect(imgRequests).toEqual(imgs.slice(0, 3).flatMap((u) => [`127.0.0.1:${port} HEAD ${new URL(u).pathname}`, `127.0.0.1:${port} GET ${new URL(u).pathname} range=bytes=0-65535`]));
  });

  it("checks external resources while pages are still being fetched, and the site's own images only after the URL phase", async () => {
    const port = srv.port;
    const o = srv.origin;
    const events: { at: number; what: string }[] = [];
    const t0 = Date.now();
    const note = (what: string) => events.push({ at: Date.now() - t0, what });
    // 8 slow pages in a chain; the first links to 4 external URLs and carries 2 own-host images.
    const pages = Array.from({ length: 8 }, (_, i) => `/p${i}`);
    const ext = [0, 1, 2, 3].map((i) => `http://ext${i}.test:${port}/x/${i}`);
    srv.routes.set("/", send(`<!doctype html><title>t</title><body><a href="/p0">p</a>${ext.map((l) => `<a href="${l}">x</a>`).join("")}<img src="/img/a.png" alt=""><img src="/img/b.png" alt=""></body>`));
    pages.forEach((p, i) =>
      srv.routes.set(p, (req, res) => {
        note(`page ${p}`);
        setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end(`<!doctype html><title>${p}</title><body>${i + 1 < pages.length ? `<a href="${pages[i + 1]}">n</a>` : ""}</body>`), 250);
      }),
    );
    for (const l of ext) srv.routes.set(new URL(l).pathname, (req, res) => (note(`ext ${req.method} ${new URL(l).pathname}`), res.writeHead(200).end()));
    for (const i of ["/img/a.png", "/img/b.png"]) srv.routes.set(i, (req, res) => (note(`img ${req.method} ${i}`), res.writeHead(200, { "content-type": "image/svg+xml" }).end()));
    srv.routes.set("/robots.txt", send("User-agent: *\nAllow: /\n", "text/plain"));

    const c = await newCrawl(db, { siteOrigin: o, status: "queued" });
    expect(await runCrawl(opts(), c)).toBe("completed");
    const lastPage = Math.max(...events.filter((e) => e.what.startsWith("page")).map((e) => e.at));
    const extEvents = events.filter((e) => e.what.startsWith("ext"));
    const imgEvents = events.filter((e) => e.what.startsWith("img"));
    expect(extEvents.length).toBe(4);
    // External links ran beside the page crawl, not after it…
    expect(extEvents.every((e) => e.at < lastPage), JSON.stringify(events)).toBe(true);
    // …and the crawled host's own images waited for the URL phase to end.
    expect(imgEvents.length).toBe(2);
    expect(imgEvents.every((e) => e.at > lastPage), JSON.stringify(events)).toBe(true);
    const row = (await db.execute(sql`select resources from crawls where id = ${c}::uuid`)).rows[0] as { resources: import("./resources").CrawlResourcesSummary };
    expect(row.resources).toMatchObject({ planned: true, external: { found: 4, planned: 4, overBudget: 0 }, images: { found: 2, planned: 2, overBudget: 0 } });
    expect(row.resources.urlPhaseFinishedAt).toEqual(expect.any(String));
    expect(row.resources.finishedAt).toEqual(expect.any(String));
    const rs = (await db.execute(sql`select state from resources where crawl_id = ${c}::uuid`)).rows as { state: string }[];
    expect(rs.every((r) => r.state === "done")).toBe(true);
  });

  it("never re-sends a resource an earlier run started", async () => {
    const o = srv.origin;
    srv.routes.set("/", send(`<!doctype html><title>t</title><body><img src="/i.png" alt=""><img src="/j.png" alt=""></body>`));
    srv.routes.set("/j.png", send("", "image/svg+xml"));
    const c = await newCrawl(db, { siteOrigin: o, status: "queued", budget: 1 });
    await db.execute(sql`update crawls set resources = ${JSON.stringify({ urlPhaseFinishedAt: new Date().toISOString(), planned: true, external: { found: 0, planned: 0, overBudget: 0, budget: 500 }, images: { found: 2, planned: 2, overBudget: 0, budget: 2000 } })}::jsonb where id = ${c}::uuid`);
    await db.execute(sql`insert into resources (crawl_id, kind, url, host, state) values (${c}::uuid, 'image', ${`${o}/i.png`}, ${new URL(o).host}, 'started'), (${c}::uuid, 'image', ${`${o}/j.png`}, ${new URL(o).host}, 'queued')`);
    expect(await runCrawl(opts(), c)).toBe("completed");
    const rs = (await db.execute(sql`select url, state, status from resources where crawl_id = ${c}::uuid order by id`)).rows;
    expect(rs).toEqual([
      { url: `${o}/i.png`, state: "interrupted", status: null },
      { url: `${o}/j.png`, state: "done", status: 200 },
    ]);
    expect(srv.hits.has("/i.png")).toBe(false);
  });

  it("never re-sends a probe an earlier run started", async () => {
    srv.routes.set("/", page([]));
    const o = srv.origin;
    const started: ProbeRecord = { kind: "llms_txt", url: `${o}/llms.txt`, started: true, status: null };
    const c = await newCrawl(db, { siteOrigin: o, status: "queued", probes: [started] });
    expect(await runCrawl(opts(), c)).toBe("completed");
    expect(srv.hits.has("/llms.txt")).toBe(false);
    const probes = ((await db.execute(sql`select probes from crawls where id = ${c}::uuid`)).rows[0] as { probes: ProbeRecord[] }).probes;
    expect(probes.find((p) => p.kind === "llms_txt")).toMatchObject({ status: null, skipped: expect.stringMatching(/interrupted/) });
    expect(probes.find((p) => p.kind === "favicon")).toMatchObject({ url: `${o}/favicon.ico`, status: 404 });
  });

  it("a stop while a probe waits for its throttle slot leaves it queued, unsent; the resumed run sends it once", async () => {
    const o = srv.origin;
    const c = await newCrawl(db, { siteOrigin: o, status: "running" });
    const probesOf = async () => ((await db.execute(sql`select probes from crawls where id = ${c}::uuid`)).rows[0] as { probes: ProbeRecord[] | null }).probes ?? [];
    const base = (signal: AbortSignal, existing: ProbeRecord[]): ProbeContext => ({
      db,
      crawlId: c,
      origin: o,
      existing,
      signal,
      log: () => {},
      robotsBlocked: () => null,
      robotsToken: "SiteSentryBot",
      release: async () => {},
      request: (url, opts) => srv.fetch(url, { ...opts, signal, timeoutMs: 5_000, userAgent: V2_USER_AGENT }),
      acquire: async () => "slot",
    });

    // Run 1: the host throttle never grants a slot; the crawl is paused while the first probe waits for one.
    const stop = new AbortController();
    let waiting = 0;
    const held: ProbeContext = {
      ...base(stop.signal, []),
      acquire: () => {
        waiting++;
        return new Promise((_, reject) => stop.signal.addEventListener("abort", () => reject(stop.signal.reason), { once: true }));
      },
    };
    const run1 = runProbes(held);
    while (waiting === 0) await new Promise((r) => setTimeout(r, 10));
    stop.abort(new Error("paused"));
    expect(await run1).toBe(false);
    const queued = await probesOf();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "home_scheme", started: false, status: null });
    expect(queued[0].skipped).toBeUndefined();
    expect(srv.hits.size).toBe(0); // nothing was sent

    // Run 2 (resume): the queued probe is sent, as are the rest; each exactly once.
    expect(await runProbes(base(new AbortController().signal, queued))).toBe(true);
    const after = await probesOf();
    expect(after.find((p) => p.kind === "home_scheme")).toMatchObject({ started: true, status: null, error: { code: expect.any(String) } }); // https to a plain-http server
    expect(after.find((p) => p.kind === "home_scheme")?.skipped).toBeUndefined();
    expect(after.find((p) => p.kind === "favicon")).toMatchObject({ started: true, status: 404 });
    expect(srv.hits.get("/favicon.ico")).toBe(1);
    expect(srv.hits.get("/llms.txt")).toBe(1);
  });

  it("reads another host's robots.txt before probing it: disallowed or 5xx is skipped (probe_skipped_robots), no answer is that error", async () => {
    const other = await startLocalServer(); // a second host (another port): robots.txt disallows /og.png
    const down = await startLocalServer(); // robots.txt answers 503
    const gone = await startLocalServer(); // closed before the crawl: connection refused
    await gone.close();
    try {
      other.routes.set("/robots.txt", send("User-agent: *\nDisallow: /og.png\n", "text/plain"));
      other.routes.set("/ok.png", sendBytes(png(1200, 630), "image/png"));
      down.routes.set("/robots.txt", send("down", "text/plain", 503));
      const imgs = [`${other.origin}/og.png`, `${other.origin}/ok.png`, `${down.origin}/og.png`, `${gone.origin}/og.png`];
      srv.routes.set("/", page(["/b", "/c", "/d"]));
      ["/", "/b", "/c", "/d"].forEach((path, i) => srv.routes.set(path, send(`<!doctype html><html><head><title>t${i}</title><meta property="og:image" content="${imgs[i]}"></head><body>${i ? "" : '<a href="/b">b</a><a href="/c">c</a><a href="/d">d</a>'}</body></html>`)));
      const fetch = createSafeFetch({
        resolve: async () => ["127.0.0.1"],
        isBlocked: (ip) => (ip === "127.0.0.1" ? false : isBlockedIp(ip)),
        allowedPorts: new Set([srv.port, other.port, down.port, gone.port].map(String)),
        allowLocalNames: false,
      });
      const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
      expect(await runCrawl(opts({ fetch }), c)).toBe("completed");
      const probes = ((await db.execute(sql`select probes from crawls where id = ${c}::uuid`)).rows[0] as { probes: ProbeRecord[] }).probes;
      const og = (url: string) => probes.find((p) => p.kind === "og_image" && p.url === url);
      expect(og(imgs[0])).toMatchObject({ started: false, status: null, skipCode: "probe_skipped_robots" });
      expect(og(imgs[1])).toMatchObject({ started: true, status: 200, width: 1200 });
      expect(og(imgs[2])).toMatchObject({ started: false, skipCode: "probe_skipped_robots", skipped: expect.stringMatching(/returned 503/) });
      expect(og(imgs[3])).toMatchObject({ started: false, status: null, error: { code: expect.any(String) } });
      expect(og(imgs[3])?.skipCode).toBeUndefined();
      // Each host's robots.txt is read once, stored as a probe; nothing robots.txt disallows was requested.
      expect(probes.filter((p) => p.kind === "robots_txt").map((p) => [p.url, p.status])).toEqual(
        expect.arrayContaining([
          [`${other.origin}/robots.txt`, 200],
          [`${down.origin}/robots.txt`, 503],
        ]),
      );
      expect(other.hits.get("/robots.txt")).toBe(1);
      expect(other.hits.has("/og.png")).toBe(false);
      expect(other.hits.get("/ok.png")).toBe(1);
      expect(down.hits.get("/robots.txt")).toBe(1);
      expect(down.hits.has("/og.png")).toBe(false);
    } finally {
      await other.close();
      await down.close();
    }
  });

  it("a host whose robots.txt redirects to the crawl's own is judged by the crawl's rules without a second read; another target is read once", async () => {
    // gate:p1 caught the crawl's own robots.txt requested twice: once by the crawl, once through a probe's read of
    // the www twin's robots.txt, which 301s to it.
    const twin = await startLocalServer(); // robots.txt 301 → the crawl's own robots.txt
    const relay = await startLocalServer(); // robots.txt 301 → third's robots.txt
    const third = await startLocalServer();
    try {
      srv.routes.set("/robots.txt", send("User-agent: *\nDisallow: /blocked.png\n", "text/plain"));
      twin.routes.set("/robots.txt", send("", "text/plain", 301, { location: `${srv.origin}/robots.txt` }));
      twin.routes.set("/fine.png", sendBytes(png(1200, 630), "image/png"));
      relay.routes.set("/robots.txt", send("", "text/plain", 301, { location: `${third.origin}/robots.txt` }));
      third.routes.set("/robots.txt", send("User-agent: *\nDisallow: /x.png\n", "text/plain"));
      const imgs = [`${twin.origin}/blocked.png`, `${twin.origin}/fine.png`, `${relay.origin}/x.png`];
      ["/", "/b", "/c"].forEach((path, i) => srv.routes.set(path, send(`<!doctype html><html><head><title>t${i}</title><meta property="og:image" content="${imgs[i]}"></head><body>${i ? "" : '<a href="/b">b</a><a href="/c">c</a>'}</body></html>`)));
      const fetch = createSafeFetch({
        resolve: async () => ["127.0.0.1"],
        isBlocked: (ip) => (ip === "127.0.0.1" ? false : isBlockedIp(ip)),
        allowedPorts: new Set([srv.port, twin.port, relay.port, third.port].map(String)),
        allowLocalNames: false,
      });
      const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
      expect(await runCrawl(opts({ fetch }), c)).toBe("completed");
      const probes = ((await db.execute(sql`select probes from crawls where id = ${c}::uuid`)).rows[0] as { probes: ProbeRecord[] }).probes;
      const og = (url: string) => probes.find((p) => p.kind === "og_image" && p.url === url);
      expect(og(imgs[0])).toMatchObject({ started: false, skipCode: "probe_skipped_robots", skipped: expect.stringContaining(`redirects to ${srv.origin}/robots.txt`) });
      expect(og(imgs[1])).toMatchObject({ started: true, status: 200 });
      expect(og(imgs[2])).toMatchObject({ started: false, skipCode: "probe_skipped_robots" });
      expect(srv.hits.get("/robots.txt")).toBe(1); // the crawl's own read only
      expect(twin.hits.get("/robots.txt")).toBe(1);
      expect(twin.hits.has("/blocked.png")).toBe(false);
      expect(relay.hits.get("/robots.txt")).toBe(1);
      expect(third.hits.get("/robots.txt")).toBe(1);
      expect(third.hits.has("/x.png")).toBe(false);
      expect(probes.filter((p) => p.kind === "robots_txt").map((p) => [p.url, p.status])).toEqual(
        expect.arrayContaining([
          [`${twin.origin}/robots.txt`, 301],
          [`${relay.origin}/robots.txt`, 301],
          [`${third.origin}/robots.txt`, 200],
        ]),
      );
    } finally {
      await twin.close();
      await relay.close();
      await third.close();
    }
  });

  it("skips probes robots.txt disallows on the crawled host, and sends none at all when robots.txt is a full disallow", async () => {
    const o = srv.origin;
    srv.routes.set("/robots.txt", send("User-agent: *\nDisallow: /llms.txt\nDisallow: /assets/\n", "text/plain"));
    srv.routes.set("/", send(`<!doctype html><html><head><title>t</title><meta property="og:image" content="/assets/og.png"></head><body></body></html>`));
    srv.routes.set("/llms.txt", send("# Site\n", "text/plain"));
    srv.routes.set("/assets/og.png", sendBytes(png(1200, 630), "image/png"));
    const c = await newCrawl(db, { siteOrigin: o, status: "queued" });
    expect(await runCrawl(opts(), c)).toBe("completed");
    const probes = ((await db.execute(sql`select probes from crawls where id = ${c}::uuid`)).rows[0] as { probes: ProbeRecord[] }).probes;
    const skipped = (kind: string) => probes.find((p) => p.kind === kind)?.skipped ?? null;
    expect(skipped("llms_txt")).toMatch(/^blocked by robots\.txt/);
    expect(skipped("og_image")).toMatch(/^blocked by robots\.txt/);
    expect(skipped("favicon")).toBeNull(); // /favicon.ico is allowed: probed (404 here)
    expect(srv.hits.has("/llms.txt")).toBe(false);
    expect(srv.hits.has("/assets/og.png")).toBe(false);

    srv.hits.clear();
    srv.routes.set("/robots.txt", send("down", "text/plain", 503));
    const c2 = await newCrawl(db, { siteOrigin: o, status: "queued" });
    expect(await runCrawl(opts(), c2)).toBe("completed");
    const probes2 = ((await db.execute(sql`select probes from crawls where id = ${c2}::uuid`)).rows[0] as { probes: ProbeRecord[] }).probes;
    expect(probes2.filter((p) => new URL(p.url).host === new URL(o).host).every((p) => p.skipped?.startsWith("blocked by robots.txt"))).toBe(true);
    for (const path of ["/", "/favicon.ico", "/llms.txt", "/assets/og.png"]) expect(srv.hits.has(path), path).toBe(false); // sitemap discovery still runs
  });
});

describe("runCrawl start URL redirects", () => {
  it("moves to the www/non-www twin the start URL redirects to: reads the twin's robots.txt and crawls only the twin", async () => {
    const site = await startFixtureSite();
    try {
      const fetch = createSafeFetch(workerFetchPolicy({ NODE_ENV: "test", CRAWLER_LOCAL_HOSTS: LOCAL_HOSTS_ENV, CRAWLER_LOCAL_PORTS: String(site.port), CRAWLER_LOCAL_CA: site.ca }));
      // www.fixture.test answers every path with a 301 to fixture.test.
      const c = await newCrawl(db, { siteOrigin: site.origins.www, status: "queued", budget: 6, maxDepth: 1 });
      expect(await runCrawl(opts({ fetch }), c)).toBe("completed");
      const row = (await db.execute(sql`select site_origin, start_redirect, robots from crawls where id = ${c}::uuid`)).rows[0] as { site_origin: string; start_redirect: StartRedirect; robots: { url: string; outcome: string } };
      expect(row.site_origin).toBe(site.origin);
      expect(row.start_redirect).toEqual({ kind: "twin", from: `${site.origins.www}/`, to: `${site.origin}/`, hops: [{ url: `${site.origins.www}/`, status: 301 }] });
      expect(row.robots).toMatchObject({ url: `${site.origin}/robots.txt`, outcome: "parsed" });
      const states = (await db.execute(sql`select split_part(split_part(normalised_url, '//', 2), '/', 1) as host, state, count(*)::int as n from crawl_urls where crawl_id = ${c}::uuid group by 1, 2`)).rows as { host: string; state: string; n: number }[];
      const www = new URL(site.origins.www).host;
      // On www: only the start URL, recorded as the redirect it is. Everything fetched is on the twin.
      expect(states.filter((s) => s.host === www)).toEqual([{ host: www, state: "redirected", n: 1 }]);
      expect(states.find((s) => s.host === new URL(site.origin).host && s.state === "fetched")?.n).toBeGreaterThan(0);
      // No extra pre-check request: www's robots.txt, then its start URL; then the twin's robots.txt.
      const hits = (host: string, p: string) => site.requests.filter((h) => (h.host ?? "fixture.test") === host && h.path === p).length; // main-host hits carry no host
      // www "/" twice: the start URL, and at the end the www-variant probe (IDX-021) of the twin, which is relative to it.
      expect(hits("www.fixture.test", "/")).toBe(2);
      const probes = ((await db.execute(sql`select probes from crawls where id = ${c}::uuid`)).rows[0] as { probes: ProbeRecord[] }).probes;
      expect(probes.filter((p) => p.url === `${site.origins.www}/`).map((p) => p.kind)).toEqual(["home_www"]);
      // www's robots.txt twice: as the crawl's first host, and again before the www probe (probes keep their own
      // robots.txt records per host; the one read before the move is not reused).
      expect(hits("www.fixture.test", "/robots.txt")).toBe(2);
      // www's /robots.txt itself 301s to the twin's. The crawl's first read follows it (one hit on fixture.test), and
      // the twin's robots.txt is read once more when the crawl moves. The probe's read does not follow the 301: it
      // points at the crawl's own robots.txt, whose rules then apply, so it is not requested a third time.
      expect(hits("fixture.test", "/robots.txt")).toBe(2);
    } finally {
      await site.close();
    }
  });

  it("ends the crawl as failed with start_redirected_off_host when the start URL redirects to another site", async () => {
    srv.routes.set("/", send("", "text/html", 302, { location: "http://elsewhere.test/welcome" }));
    srv.routes.set("/robots.txt", send("User-agent: *\nAllow: /\n", "text/plain"));
    const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued" });
    expect(await runCrawl(opts(), c)).toBe("failed");
    const row = (await db.execute(sql`select status, error, start_redirect from crawls where id = ${c}::uuid`)).rows[0] as { status: string; error: { code: string; message: string }; start_redirect: StartRedirect };
    expect(row.status).toBe("failed");
    expect(row.error).toMatchObject({ code: "start_redirected_off_host", message: `Started at ${srv.origin}/, which redirects to http://elsewhere.test/welcome, another site. Start a new audit on that site to crawl it.` });
    expect(row.start_redirect).toMatchObject({ kind: "off_host", from: `${srv.origin}/`, to: "http://elsewhere.test/welcome" });
    expect(srv.hits.get("/")).toBe(1);
    expect(pageHits()).toEqual([["/", 1]]); // no sitemap reading, no other page
  });

  it("isTwinOrigin: www/non-www and http/https of one host are twins; other hosts, subdomains and ports are not", () => {
    const t = (a: string, b: string) => isTwinOrigin(new URL(a), new URL(b));
    expect(t("https://example-client.ae/", "https://www.example-client.ae/")).toBe(true);
    expect(t("https://www.example.com/", "https://example.com/x")).toBe(true);
    expect(t("http://example.com/", "https://example.com/")).toBe(true);
    expect(t("http://example.com/", "https://www.example.com/")).toBe(true);
    expect(t("https://example.com/", "https://example.com/en/")).toBe(false); // same origin: not a move
    expect(t("https://example.com/", "https://shop.example.com/")).toBe(false);
    expect(t("https://example.com/", "https://example.org/")).toBe(false);
    expect(t("http://example.com:8080/", "http://www.example.com:8081/")).toBe(false);
    expect(t("https://example.com/", "ftp://example.com/")).toBe(false);
  });
});
