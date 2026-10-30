// Explorer reads end to end: audit a local site twice, then check that the row-level reads agree with the issue
// groups and carry each URL's page facts, links and issue history.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { testRedis } from "@/test/redis";
import { runCrawl, type RunnerOptions } from "@/lib/crawl/v2/runner";
import { analyseCrawl } from "@/lib/rules/analyse";
import { THIN_WORDS } from "@/lib/rules/cnt";
import { issueRows, pageDetail, urlRows } from "./explore";
import { issueGroups } from "./queries";
import { OPEN_STATES } from "./states";

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

const opts = (): RunnerOptions => ({ db, redis, politeness: { keyPrefix: `test:explore:${randomUUID()}:` }, fetch: srv.fetch, owner: "test", leaseMs: 30_000 });
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(" ");
const page = (title: string, n: number, head = "", body = "") =>
  send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${words(n)}</p>${body}</main></body></html>`, "text/html; charset=utf-8");

function serve() {
  srv.routes.clear();
  srv.routes.set("/robots.txt", send("User-agent: *\nAllow: /\n", "text/plain"));
  srv.routes.set("/", page("Home", THIN_WORDS + 50, "", `<a href="/a">Thin page</a><a href="/b">B</a><a href="/c">C</a>`));
  srv.routes.set("/a", page("A", 20, "", `<a href="/b">to b</a>`));
  srv.routes.set("/b", page("B", THIN_WORDS + 50, `<meta name="robots" content="noindex"><link rel="canonical" href="/a">`));
  srv.routes.set("/c", send("", "text/html", 301, { location: "/a" }));
}

async function analysedCrawl(project: string): Promise<string> {
  const c = await newCrawl(db, { siteOrigin: srv.origin, siteId: project, status: "queued", maxDepth: 5 });
  expect(await runCrawl(opts(), c)).toBe("completed");
  expect((await analyseCrawl(db, c)).outcome).toBe("analysed");
  return c;
}

describe("explorer reads", () => {
  it("lists issues, URLs and one page consistently with the issue groups", async () => {
    const project = `p-${randomUUID()}`;
    serve();
    const first = await analysedCrawl(project);
    const audit = await analysedCrawl(project);
    const u = (p: string) => `${srv.origin}${p}`;

    // Issue rows: one per fingerprint, and per rule the same state counts as the issue groups.
    const issues = await issueRows(db, audit);
    expect(issues.length).toBeGreaterThan(0);
    expect(new Set(issues.map((i) => i.fingerprint)).size).toBe(issues.length);
    const perRule = new Map<string, Record<string, number>>();
    for (const i of issues) {
      const s = perRule.get(i.ruleId) ?? {};
      s[i.state] = (s[i.state] ?? 0) + 1;
      perRule.set(i.ruleId, s);
    }
    for (const g of await issueGroups(db, audit)) expect(perRule.get(g.ruleId), g.ruleId).toEqual(g.states);
    const thin = issues.find((i) => i.ruleId === "CNT-005" && i.url === u("/a"));
    expect(thin).toMatchObject({ state: "persistent", outcome: "issue", verified: false });
    expect(thin?.message).toBeTruthy();

    // URL rows: page facts from the snapshot, redirects without one, open issue counts matching the issue rows.
    const urls = await urlRows(db, audit);
    const byUrl = new Map(urls.map((x) => [x.url, x]));
    expect(byUrl.get(u("/b"))).toMatchObject({ state: "analysed", status: 200, title: "B", h1: "B", noindex: true, canonical: u("/a") });
    expect(byUrl.get(u("/a"))).toMatchObject({ noindex: false, canonical: null, wordCount: expect.any(Number) });
    expect(byUrl.get(u("/c"))).toMatchObject({ state: "redirected", status: 301, title: null, redirectTarget: u("/a") });
    for (const x of urls) {
      const open = issues.filter((i) => i.url === x.url && (OPEN_STATES as string[]).includes(i.state)).length;
      expect(x.openIssues, x.url).toBe(open);
    }

    // Page detail: snapshot, links in (home, /c's redirect) and out, issues with their state in both audits.
    const a = await pageDetail(db, audit, u("/a"));
    expect(a?.snapshot).toMatchObject({ status_code: 200 });
    expect(a?.linksIn.map((e) => e.url)).toEqual(expect.arrayContaining([u("/"), u("/c")]));
    expect(a?.linksInTotal).toBe(a?.linksIn.length);
    expect(a?.linksOut.map((e) => e.url)).toContain(u("/b"));
    const t = a?.issues.find((i) => i.ruleId === "CNT-005");
    expect(t?.history.map((h) => [h.crawlId, h.state])).toEqual([
      [first, "new"],
      [audit, "persistent"],
    ]);
    expect(a?.issues.map((i) => i.fingerprint).sort()).toEqual(issues.filter((i) => i.url === u("/a")).map((i) => i.fingerprint).sort());

    // A redirect has no snapshot; a URL the crawl never saw has no detail.
    expect((await pageDetail(db, audit, u("/c")))?.snapshot).toBeNull();
    expect(await pageDetail(db, audit, u("/nowhere"))).toBeNull();
  });
});
