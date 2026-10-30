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
import { ANSWERED, NOT_OURS } from "@/lib/results/coverage";
import { CATEGORY_WEIGHTS, type Health } from "@/lib/results/health";
import { CONFIDENCE_WEIGHT } from "@/lib/results/priority";

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
    // A first audit: the history rules (SITE-004, SITE-005) have nothing to compare with and do not run.
    expect(runs).toHaveLength(RULES.filter((r) => r.scope !== "history").length);
    for (const r of RULES.filter((x) => x.scope !== "history")) {
      const run = runs.find((x) => x.rule_id === r.id)!;
      // Resource rules run once per checked image or external link; this site has neither. This audit does not
      // render, so the rules that read the render evaluate nothing and need configuration.
      const rendered = r.needs.includes("rendered");
      expect(run.evaluated, r.id).toBe(rendered || r.scope === "resource" ? 0 : r.scope === "page" ? 5 : 1);
      if (rendered) expect(run.status, r.id).toBe("needs_config");
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
    expect(crawl.analysis).toMatchObject({ duplicateFingerprints: 0 });

    // Every finding has a fingerprint and an occurrence; one issue group per rule with an occurrence, inputs stored.
    const unfp = (await db.execute(sql`select count(*)::int as n from findings f where crawl_id = ${c}::uuid and (fingerprint is null
      or not exists (select 1 from finding_occurrences o where o.crawl_id = f.crawl_id and o.fingerprint = f.fingerprint))`)).rows[0] as { n: number };
    expect(unfp.n).toBe(0);
    const groups = (await db.execute(sql`select * from issue_groups where crawl_id = ${c}::uuid order by rule_id`)).rows as Record<string, unknown>[];
    expect(groups.map((g) => g.rule_id)).toEqual([...new Set(f.map((x) => x.rule_id))].sort());
    expect(crawl.analysis.issueGroups).toBe(groups.length);
    // /, /a, /new are indexable (/b noindex, /missing 404). CNT-005 (thin) is on all three: reach ln 4 / ln 4 = 1.
    // IDX-001 is on /missing, a URL that is not a page: it counts once, reach ln 2 / ln 4 = 0.5.
    const at = (id: string) => groups.find((g) => g.rule_id === id)!;
    const rule = RULES.find((r) => r.id === "CNT-005")!;
    expect(f.filter((x) => x.rule_id === "CNT-005").map((x) => new URL(x.url).pathname).sort()).toEqual(["/", "/a", "/new"]);
    expect(at("CNT-005")).toMatchObject({ indexable_pages: 3, affected_pages: 3, affected_urls: 3, impact: rule.impact, confidence: rule.confidence, reach: 1 });
    expect(at("CNT-005").score).toBeCloseTo(rule.impact * { verified: 1, heuristic: 0.6, advisory: 0.3 }[rule.confidence], 4);
    expect(at("IDX-001")).toMatchObject({ affected_pages: 1, affected_urls: 1 });
    expect(at("IDX-001").reach).toBeCloseTo(0.5, 4);

    // Rule, then template: per-template counts add up to the group's, samples are the first URLs in order.
    const split = (await db.execute(sql`select * from issue_group_templates where crawl_id = ${c}::uuid order by rule_id, template_id`)).rows as Record<string, unknown>[];
    const tpl = (await db.execute(sql`select normalised_url as url, template_id from crawl_urls where crawl_id = ${c}::uuid`)).rows as { url: string; template_id: string | null }[];
    for (const g of groups.filter((x) => (x.affected_urls as number) > 0)) {
      const mine = split.filter((x) => x.rule_id === g.rule_id);
      expect(mine.reduce((n, x) => n + (x.affected_urls as number), 0), String(g.rule_id)).toBe(g.affected_urls);
      expect(g.template_count, String(g.rule_id)).toBe(mine.filter((x) => x.template_id !== "").length);
      const issues = (await db.execute(sql`select distinct url from findings where crawl_id = ${c}::uuid and rule_id = ${g.rule_id as string} and outcome = 'issue'`)).rows as { url: string }[];
      const urls = issues.map((x) => x.url).sort();
      expect(g.sample_urls, String(g.rule_id)).toEqual(urls.slice(0, 5));
    }
    const cntTemplates = new Set(tpl.filter((t) => ["/", "/a", "/new"].includes(new URL(t.url).pathname)).map((t) => t.template_id));
    expect(at("CNT-005").template_count).toBe(cntTemplates.size);

    // Health: per category 100 × (1 − Σ group score / Σ impact × confidence weight) over the rules that ran,
    // weighted mean over those categories; coverage from URL states (the private URL is robots-blocked: not ours).
    const health = ((await db.execute(sql`select health from crawls where id = ${c}::uuid`)).rows[0] as { health: Health }).health;
    const ran = (await db.execute(sql`select rule_id from rule_runs where crawl_id = ${c}::uuid and status = 'ran'`)).rows.map((x) => RULES.find((r) => r.id === (x as { rule_id: string }).rule_id)!);
    const cats = new Map<string, { d: number; m: number }>();
    for (const r of ran) {
      if (!(r.category in CATEGORY_WEIGHTS)) continue; // performance, accessibility: no published weight, not scored
      const e = cats.get(r.category) ?? { d: 0, m: 0 };
      e.d += Number(groups.find((g) => g.rule_id === r.id)?.score ?? 0);
      e.m += r.impact * CONFIDENCE_WEIGHT[r.confidence];
      cats.set(r.category, e);
    }
    let num = 0;
    let den = 0;
    for (const [cat, e] of cats) {
      const score = Math.round(1000 * (1 - e.d / e.m)) / 10;
      expect(health.categories[cat as keyof Health["categories"]]?.score, cat).toBe(score);
      num += CATEGORY_WEIGHTS[cat as keyof typeof CATEGORY_WEIGHTS] * score;
      den += CATEGORY_WEIGHTS[cat as keyof typeof CATEGORY_WEIGHTS];
    }
    expect(health.score).toBe(Math.round((10 * num) / den) / 10);
    const answered = states.filter((x) => ANSWERED.includes(x.state)).reduce((n, x) => n + x.n, 0);
    const eligible = states.filter((x) => !NOT_OURS.includes(x.state)).reduce((n, x) => n + x.n, 0);
    expect(health.coveragePercent).toBe(Math.round((1000 * answered) / eligible) / 10);
    expect(health.partialCoverage).toBe(answered / eligible < 0.5);
    expect(crawl.analysis).toMatchObject({ health: health.score, partialCoverage: health.partialCoverage });
  });

  it("is idempotent and gives the same result whatever the batch size", async () => {
    const c = await crawlSmallSite();
    await analyseCrawl(db, c);
    const first = await findingRows(c);
    await analyseCrawl(db, c, { batchSize: 2 });
    const second = await findingRows(c);
    expect(second).toEqual(first);
    const runs = (await db.execute(sql`select count(*)::int as n from rule_runs where crawl_id = ${c}::uuid`)).rows[0] as { n: number };
    expect(runs.n).toBe(RULES.filter((r) => r.scope !== "history").length);
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
