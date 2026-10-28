import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { activeCount, stateCounts } from "./frontier";
import { runCrawl, type RunnerOptions } from "./runner";

const db = testDb();
afterAll(() => db.$client.end());

let srv: LocalServer;
beforeEach(async () => {
  srv = await startLocalServer();
});
afterEach(async () => {
  await srv.close();
});

const page = (links: string[], title = "page") => send(`<!doctype html><html><head><title>${title}</title></head><body><main>${links.map((l) => `<a href="${l}">${l}</a>`).join("")}</main></body></html>`);
const urlset = (urls: string[]) => `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map((u) => `<url><loc>${u}</loc></url>`).join("")}</urlset>`;

const opts = (over: Partial<RunnerOptions> = {}): RunnerOptions => ({ db, fetch: srv.fetch, owner: "test", leaseMs: 30_000, ...over });

async function urlStates(crawlId: string) {
  const r = await db.execute(sql`select normalised_url as url, state, reason, depth, discovered_via from crawl_urls where crawl_id = ${crawlId}::uuid order by id`);
  const out: Record<string, { state: string; reason: string | null; depth: number | null; via: string[] }> = {};
  for (const row of r.rows as { url: string; state: string; reason: string | null; depth: number | null; discovered_via: string[] }[]) {
    out[row.url.replace(srv.origin, "")] = { state: row.state, reason: row.reason, depth: row.depth, via: row.discovered_via };
  }
  return out;
}

const pageHits = () => [...srv.hits.entries()].filter(([p]) => p !== "/robots.txt" && !p.endsWith(".xml"));
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
    // A sitemap-only page counts as depth 0 for its children.
    expect(s["/from-sitemap-page"]).toMatchObject({ state: "fetched", depth: 1, via: ["link"] });

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
    expect(await runCrawl(opts({ concurrency: 1 }), c)).toBe("paused");
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
    expect(await runCrawl(opts({ concurrency: 1 }), c)).toBe("cancelled");
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
