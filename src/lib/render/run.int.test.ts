// The render phase end to end: a real crawl of a local site, then renderCrawl with a real browser. Sampled mode
// renders one page per template plus the start URL; full renders every HTML page; analysis waits for the phase.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { testRedis } from "@/test/redis";
import { runCrawl } from "@/lib/crawl/v2/runner";
import { analyseCrawl } from "@/lib/rules/analyse";
import { unanalysedCrawls } from "@/lib/rules/queue";
import { blobStoreFromEnv, getRawHtml } from "@/lib/snapshot/blob-store";
import { RenderPool } from "./pool";
import { crawlGate, markRenderFailed, planRenders, renderCrawl, unrenderedCrawls, type RenderedExtract, type RenderProgress } from "./run";

const db = testDb();
const redis = testRedis();
let srv: LocalServer;
let pool: RenderPool;
const store = blobStoreFromEnv();

const article = (n: number) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Article ${n}</title><link rel="canonical" href="/articles/${n}"></head>
   <body><header><nav><a href="/">Home</a></nav></header><main><article><h1>Article ${n}</h1><p>${"word ".repeat(40)}</p></article></main><footer>f</footer></body></html>`;

beforeAll(async () => {
  srv = await startLocalServer();
  srv.routes.set("/robots.txt", send("User-agent: *\nDisallow: /private/\n", "text/plain"));
  srv.routes.set(
    "/",
    send(`<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p>Start here.</p>
      <a href="/articles/1">1</a><a href="/articles/22">22</a><a href="/articles/333">333</a><a href="/js">JS</a></main></body></html>`),
  );
  for (const n of [1, 22, 333]) srv.routes.set(`/articles/${n}`, send(article(n)));
  // Content, links and canonical written only by JavaScript; its script on a robots-disallowed path is not loaded.
  srv.routes.set(
    "/js",
    send(`<!doctype html><html lang="en"><head><title>JS</title><link rel="canonical" href="/js"><script src="/app.js"></script><script src="/private/x.js"></script></head>
      <body><div id="root"></div></body></html>`),
  );
  srv.routes.set(
    "/app.js",
    send(
      `document.addEventListener("DOMContentLoaded", () => {
        document.getElementById("root").innerHTML = "<main><h1>Rendered</h1><p>${"rendered ".repeat(120)}</p><a href='/only-js'>Only JS</a></main>";
        document.querySelector("link[rel=canonical]").href = "/js-canonical";
      });`,
      "application/javascript",
    ),
  );
  pool = new RenderPool({ fetch: srv.fetch });
});
afterAll(async () => {
  await pool?.close();
  await srv?.close();
  await db.$client.end();
  await redis.quit();
});

async function crawl(render: "sampled" | "full" | undefined): Promise<string> {
  const c = await newCrawl(db, { siteOrigin: srv.origin, status: "queued", maxDepth: 3, config: render ? { render } : {} });
  const outcome = await runCrawl({ db, redis, politeness: { keyPrefix: `test:render:${randomUUID()}:` }, fetch: srv.fetch, owner: "test", leaseMs: 30_000 }, c);
  expect(outcome).toBe("completed");
  return c;
}

const renders = async (c: string) =>
  (await db.execute(sql`select r.url, r.status, r.extract, r.metrics, r.requests, r.rendered_html_key from page_renders r where r.crawl_id = ${c}::uuid order by r.url collate "C"`)).rows as {
    url: string;
    status: string;
    extract: RenderedExtract | null;
    metrics: { source: string } | null;
    requests: { url: string; outcome: string; reason?: string }[];
    rendered_html_key: string | null;
  }[];
const progress = async (c: string) => ((await db.execute(sql`select render from crawls where id = ${c}::uuid`)).rows[0] as { render: RenderProgress | null }).render;

describe("render phase", () => {
  it("full mode renders every HTML page, records what JavaScript changed, and holds analysis until it is done", { timeout: 120_000 }, async () => {
    const c = await crawl("full");
    // Waiting for its render phase: not analysed, and not offered to the analysis queue.
    expect((await analyseCrawl(db, c)).outcome).toBe("not_ready");
    expect(await unanalysedCrawls(db)).not.toContain(c);
    expect(await unrenderedCrawls(db)).toContain(c);

    expect(await renderCrawl({ db, pool, store, gate: ({ origin, robots }) => crawlGate(origin, robots) }, c)).toBe("done");
    const rows = await renders(c);
    expect(rows.map((r) => r.url)).toEqual(["/", "/articles/1", "/articles/22", "/articles/333", "/js"].map((p) => `${srv.origin}${p}`));
    expect(rows.every((r) => r.status === "rendered" && r.metrics?.source === "lab" && r.rendered_html_key)).toBe(true);

    const js = rows.find((r) => r.url.endsWith("/js"))!;
    expect(js.extract!.wordCount).toBeGreaterThanOrEqual(120);
    expect(js.extract!.titles).toEqual(["JS"]);
    expect(js.extract!.canonicals[0]).toMatchObject({ resolved: `${srv.origin}/js-canonical`, location: "head" });
    expect(js.extract!.links).toMatchObject({ renderedOnly: [`${srv.origin}/only-js`], renderedOnlyCount: 1, rawOnlyCount: 0 });
    // robots.txt applies to the page's own requests, as for Googlebot.
    expect(js.requests.find((q) => q.url.endsWith("/private/x.js"))).toMatchObject({ outcome: "blocked", reason: "robots" });
    expect(srv.hits.get("/private/x.js")).toBeUndefined();
    // Rendered-only links are evidence, never crawled.
    expect(srv.hits.get("/only-js")).toBeUndefined();
    const html = await getRawHtml(store, js.rendered_html_key!);
    expect(html).toContain("Rendered");

    expect(await progress(c)).toMatchObject({ mode: "full", status: "done", planned: 5, rendered: 5, timeouts: 0, errors: 0 });
    expect(await unrenderedCrawls(db)).not.toContain(c);
    expect(await unanalysedCrawls(db)).toContain(c);
    expect((await analyseCrawl(db, c)).outcome).toBe("analysed");
    // A second run renders nothing again.
    expect(await renderCrawl({ db, pool, store }, c)).toBe("done");
    expect((await renders(c)).length).toBe(5);
  });

  it("sampled mode renders the shortest URL of each template and the start URL", { timeout: 120_000 }, async () => {
    const c = await crawl("sampled");
    const plan = await planRenders(db, c, "sampled");
    const urls = plan.map((p) => p.url.slice(srv.origin.length));
    // The three articles share one template: only the shortest URL is rendered.
    expect(urls).toContain("/");
    expect(urls).toContain("/articles/1");
    expect(urls).not.toContain("/articles/22");
    expect(urls).not.toContain("/articles/333");
    const groups = (await db.execute(sql`select count(distinct s.template_fingerprint)::int as n from page_snapshots s where s.crawl_id = ${c}::uuid and s.facts is not null`)).rows[0] as { n: number };
    expect(plan.length).toBeLessThanOrEqual(groups.n + 1);
    expect(await renderCrawl({ db, pool, store }, c)).toBe("done");
    expect((await renders(c)).length).toBe(plan.length);
    expect((await full(c)).length).toBe(5);
  });

  it("a crawl without a render mode is not rendered; a failed phase still lets analysis run", { timeout: 120_000 }, async () => {
    const off = await crawl(undefined);
    expect(await renderCrawl({ db, pool, store }, off)).toBe("skipped");
    expect(await unrenderedCrawls(db)).not.toContain(off);
    expect((await analyseCrawl(db, off)).outcome).toBe("analysed");

    const failed = await crawl("full");
    await markRenderFailed(db, failed, "Chromium could not start.");
    expect(await progress(failed)).toMatchObject({ mode: "full", status: "failed", error: "Chromium could not start." });
    expect(await unrenderedCrawls(db)).not.toContain(failed);
    expect((await analyseCrawl(db, failed)).outcome).toBe("analysed");
  });
});

/** Every page full mode would render. */
const full = (c: string) => planRenders(db, c, "full");
