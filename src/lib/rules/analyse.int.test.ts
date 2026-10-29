// The analysis job end to end: a real crawl of a local site, then analyseCrawl over its snapshots.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { testRedis } from "@/test/redis";
import { redisConnection } from "@/lib/crawl/v2/queue";
import { runCrawl, type RunnerOptions } from "@/lib/crawl/v2/runner";
import { analyseCrawl } from "./analyse";
import { RULES } from "./registry";

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

const opts = (): RunnerOptions => ({ db, redis, politeness: { keyPrefix: `test:analyse:${randomUUID()}:` }, fetch: srv.fetch, owner: "test", leaseMs: 30_000 });
const doc = (title: string, body: string, head = "") =>
  send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main>${body}</main></body></html>`, "text/html; charset=utf-8");

async function crawlSmallSite(): Promise<string> {
  const o = srv.origin;
  srv.routes.set("/robots.txt", send(`User-agent: *\nDisallow: /private/\n\nSitemap: ${o}/sitemap.xml\n`, "text/plain"));
  srv.routes.set("/sitemap.xml", send(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${o}/</loc></url><url><loc>${o}/private/listed</loc></url></urlset>`, "application/xml"));
  srv.routes.set("/", doc("Home page of the analysis test", `<h1>Home</h1><a href="/a">a</a><a href="/b">b</a><a href="/old">old</a><a href="/missing">m</a>`));
  srv.routes.set("/a", doc("Same title", "<h1>A</h1>"));
  srv.routes.set("/b", doc("Same title", "<h1>B</h1>", '<meta name="robots" content="noindex">'));
  srv.routes.set("/old", send("", "text/html", 301, { location: "/new" }));
  srv.routes.set("/new", doc("New page of the analysis test", "<h1>New</h1>"));
  srv.routes.set("/missing", send("", "text/html", 404));
  const c = await newCrawl(db, { siteOrigin: o, status: "queued", maxDepth: 5 });
  expect(await runCrawl(opts(), c)).toBe("completed");
  return c;
}

const findingRows = async (c: string) =>
  (await db.execute(sql`select rule_id, rule_version, url, confidence, message, evidence from findings where crawl_id = ${c}::uuid order by rule_id, url`)).rows as {
    rule_id: string;
    rule_version: number;
    url: string;
    confidence: string;
  }[];

describe("analyseCrawl", () => {
  it("runs every rule over the crawl's snapshots and stores findings, rule runs and the summary", async () => {
    const c = await crawlSmallSite();
    const o = srv.origin;
    const res = await analyseCrawl(db, c);
    expect(res.outcome).toBe("analysed");
    expect(res.pages).toBe(5); // /, /a, /b, /new, /missing (the redirect has no snapshot of its own)

    const f = await findingRows(c);
    const has = (rule: string, url: string) => f.some((x) => x.rule_id === rule && x.url === url);
    expect(has("IDX-001", `${o}/missing`)).toBe(true);
    expect(has("IDX-007", `${o}/private/listed`)).toBe(true);
    expect(has("META-011", `${o}/a`)).toBe(false); // lang="en" is set
    expect(has("META-004", `${o}/a`)).toBe(false); // /b shares the title but is noindex, so not a duplicate
    expect(has("META-008", `${o}/a`)).toBe(true);
    expect(has("CNT-005", `${o}/a`)).toBe(true);
    expect(has("CNT-005", `${o}/b`)).toBe(false); // noindexed pages are not judged thin
    for (const x of f) expect(x.rule_version).toBe(RULES.find((r) => r.id === x.rule_id)!.version);
    expect(res.findings).toBe(f.length);

    const runs = (await db.execute(sql`select rule_id, status, evaluated, findings from rule_runs where crawl_id = ${c}::uuid`)).rows as { rule_id: string; status: string; evaluated: number; findings: number }[];
    expect(runs).toHaveLength(RULES.length);
    for (const r of RULES) {
      const run = runs.find((x) => x.rule_id === r.id)!;
      expect(run.evaluated, r.id).toBe(r.scope === "page" ? 5 : 1);
    }
    expect(runs.find((x) => x.rule_id === "AIS-002")!.status).toBe("needs_config");
    expect(runs.filter((x) => x.status === "error")).toEqual([]);

    // The redirect chain is filled in from the redirect rows.
    const chain = (await db.execute(sql`select s.redirect_chain from page_snapshots s join crawl_urls u on u.id = s.url_id where u.crawl_id = ${c}::uuid and u.normalised_url = ${`${o}/new`}`)).rows[0] as { redirect_chain: unknown };
    expect(chain.redirect_chain).toEqual([{ url: `${o}/old`, status: 301 }]);

    const states = (await db.execute(sql`select state, count(*)::int as n from crawl_urls where crawl_id = ${c}::uuid group by state`)).rows as { state: string; n: number }[];
    expect(states.find((s) => s.state === "fetched")).toBeUndefined();
    expect(states.find((s) => s.state === "analysed")?.n).toBe(5);

    const crawl = (await db.execute(sql`select analysis from crawls where id = ${c}::uuid`)).rows[0] as { analysis: Record<string, unknown> };
    expect(crawl.analysis).toMatchObject({ status: "completed", pages: 5, findings: f.length });
    expect(typeof crawl.analysis.msPerPage).toBe("number");
  });

  it("is idempotent and gives the same result whatever the batch size", async () => {
    const c = await crawlSmallSite();
    await analyseCrawl(db, c);
    const first = await findingRows(c);
    await analyseCrawl(db, c, { batchSize: 2 });
    const second = await findingRows(c);
    expect(second).toEqual(first);
    const runs = (await db.execute(sql`select count(*)::int as n from rule_runs where crawl_id = ${c}::uuid`)).rows[0] as { n: number };
    expect(runs.n).toBe(RULES.length);
  });

  it("site pass: inbound links, click depth, PageRank and templates, streamed in small batches", async () => {
    const c = await crawlSmallSite();
    const o = srv.origin;
    expect((await analyseCrawl(db, c, { batchSize: 2 })).outcome).toBe("analysed");
    const rows = (await db.execute(sql`select normalised_url as url, inbound, link_depth, pagerank, template_id from crawl_urls where crawl_id = ${c}::uuid order by id`)).rows as {
      url: string;
      inbound: number;
      link_depth: number | null;
      pagerank: number | null;
      template_id: string | null;
    }[];
    const at = (p: string) => rows.find((r) => r.url === `${o}${p}`)!;
    expect(at("/")).toMatchObject({ inbound: 0, link_depth: 0 });
    expect(at("/a")).toMatchObject({ inbound: 1, link_depth: 1 });
    expect(at("/missing")).toMatchObject({ inbound: 1, link_depth: 1 });
    // The link to /old is credited to its redirect target; the click path runs through the redirect.
    expect(at("/old")).toMatchObject({ inbound: 0, link_depth: 1 });
    expect(at("/new")).toMatchObject({ inbound: 1, link_depth: 2 });
    // Blocked by robots.txt: never fetched, so no page links from it and no path to it beyond the sitemap.
    expect(at("/private/listed")).toMatchObject({ inbound: 0, link_depth: null });
    for (const r of rows) expect(r.pagerank, r.url).toBeGreaterThanOrEqual(0);
    expect(Math.max(...rows.map((r) => r.pagerank!))).toBe(100);
    expect(at("/a").pagerank).toBe(at("/b").pagerank); // same position in the graph

    const html = rows.filter((r) => ["/", "/a", "/b", "/new"].some((p) => r.url === `${o}${p}`));
    for (const r of html) expect(r.template_id, r.url).toEqual(expect.any(String));
    const t = (await db.execute(sql`select sum(page_count)::int as n, count(*)::int as groups from templates where crawl_id = ${c}::uuid`)).rows[0] as { n: number; groups: number };
    expect(t.n).toBe(html.length);
    expect(t.groups).toBe(new Set(html.map((r) => r.template_id)).size);
  });

  it("refuses a crawl that is still running", async () => {
    const c = await newCrawl(db, { status: "running" });
    expect((await analyseCrawl(db, c)).outcome).toBe("not_ready");
  });

  it("is driven by the analysis queue", async () => {
    const c = await crawlSmallSite();
    process.env.ANALYSIS_QUEUE_NAME = `analysis-test-${randomUUID()}`;
    const { createAnalysisQueue, enqueueAnalysis, startAnalysisWorker } = await import("./queue");
    const queue = createAnalysisQueue(redisConnection());
    const worker = startAnalysisWorker({ db, log: () => {} });
    try {
      await enqueueAnalysis(queue, c);
      await enqueueAnalysis(queue, c); // same job id while waiting: a no-op
      const deadline = Date.now() + 20_000;
      let analysis: { status?: string } | null = null;
      while (Date.now() < deadline) {
        analysis = ((await db.execute(sql`select analysis from crawls where id = ${c}::uuid`)).rows[0] as { analysis: { status?: string } | null }).analysis;
        if (analysis?.status === "completed") break;
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(analysis?.status).toBe("completed");
    } finally {
      await worker.close();
      await queue.obliterate({ force: true });
      await queue.close();
      delete process.env.ANALYSIS_QUEUE_NAME;
    }
  });
});
