// Finding states across three audits of one project: a real crawl of a local site that changes between audits.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { testRedis } from "@/test/redis";
import { runCrawl, type RunnerOptions } from "@/lib/crawl/v2/runner";
import { analyseCrawl } from "@/lib/rules/analyse";
import { findingFingerprint } from "@/lib/rules/fingerprint";
import { THIN_WORDS } from "@/lib/rules/cnt";
import { compareCrawls } from "./queries";
import { writeIssueStates } from "./states";

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

const opts = (): RunnerOptions => ({ db, redis, politeness: { keyPrefix: `test:states:${randomUUID()}:` }, fetch: srv.fetch, owner: "test", leaseMs: 30_000 });
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(" ");
const page = (title: string, thin: boolean, twoTitles = false) =>
  send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${twoTitles ? `<title>${title} again</title>` : ""}</head><body><main><h1>${title}</h1><p>${words(thin ? 20 : THIN_WORDS + 50)}</p></main></body></html>`, "text/html; charset=utf-8");

/** One audit: serve the site as given, crawl it as project `project`, analyse it. */
async function audit(project: string, thin: Record<"/a" | "/b" | "/c", boolean>, robots = "User-agent: *\nAllow: /\n", twoTitlesOnC = false): Promise<string> {
  srv.routes.set("/robots.txt", send(robots, "text/plain"));
  srv.routes.set("/", send(`<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p>${words(THIN_WORDS + 50)}</p><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></main></body></html>`, "text/html"));
  for (const [path, t] of Object.entries(thin)) srv.routes.set(path, page(`Page ${path}`, t, twoTitlesOnC && path === "/c"));
  const c = await newCrawl(db, { siteOrigin: srv.origin, siteId: project, status: "queued", maxDepth: 5 });
  expect(await runCrawl(opts(), c)).toBe("completed");
  expect((await analyseCrawl(db, c)).outcome).toBe("analysed");
  return c;
}

async function stateOf(crawlId: string, path: string, rule = "CNT-005"): Promise<string | undefined> {
  const fp = findingFingerprint(rule, `${srv.origin}${path}`, "");
  const r = await db.execute(sql`select state from issue_states where crawl_id = ${crawlId}::uuid and fingerprint = ${fp}`);
  return (r.rows[0] as { state: string } | undefined)?.state;
}

const allStates = async (crawlId: string) =>
  (await db.execute(sql`select fingerprint, state from issue_states where crawl_id = ${crawlId}::uuid order by fingerprint`)).rows;

describe("issue states across audits", () => {
  it("new, persistent, resolved, regressed and not_rechecked, with a URL not crawled never resolving", async () => {
    const project = `p-${randomUUID()}`;
    const a1 = await audit(project, { "/a": true, "/b": true, "/c": false });
    expect(await stateOf(a1, "/a")).toBe("new");
    expect(await stateOf(a1, "/b")).toBe("new");
    expect(await stateOf(a1, "/c")).toBeUndefined();

    // Full second audit: /a fixed, /b unchanged, /c now thin.
    const a2 = await audit(project, { "/a": false, "/b": true, "/c": true }, undefined, true);
    expect(await stateOf(a2, "/a")).toBe("resolved");
    expect(await stateOf(a2, "/b")).toBe("persistent");
    expect(await stateOf(a2, "/c")).toBe("new");

    // Third audit cannot fetch /b (robots.txt); /b is fixed on the server, but the audit did not see it.
    // /a is thin again: regressed.
    const a3 = await audit(project, { "/a": true, "/b": false, "/c": true }, "User-agent: *\nDisallow: /b\n");
    expect(await stateOf(a3, "/b")).toBe("not_rechecked");
    expect(await stateOf(a3, "/a")).toBe("regressed");
    expect(await stateOf(a3, "/c")).toBe("persistent");

    // Fourth audit fetches /b again: the not_rechecked finding is now checked and gone.
    const a4 = await audit(project, { "/a": true, "/b": false, "/c": true }, undefined, true);
    expect(await stateOf(a4, "/b")).toBe("resolved");
    expect(await stateOf(a4, "/a")).toBe("persistent");

    // Another project's audits are a separate history.
    const other = await audit(`p-${randomUUID()}`, { "/a": false, "/b": true, "/c": true });
    expect(await stateOf(other, "/b")).toBe("new");
    expect(await stateOf(other, "/a")).toBeUndefined();

    // Comparisons: per fingerprint, then per group (CNT-005 thin pages; META-003 two titles on /c in audits 2 and 4).
    const cmp = async (x: string, y: string) => {
      const c = await compareCrawls(db, x, y);
      return { c, g: (rule: string) => c.groups.find((g) => g.ruleId === rule) };
    };
    const zero = { new: 0, persistent: 0, resolved: 0, regressed: 0, not_rechecked: 0, inconclusive: 0 };
    let r = await cmp(a1, a2);
    expect(r.g("CNT-005")).toEqual({ ruleId: "CNT-005", change: "persistent", counts: { ...zero, persistent: 1, resolved: 1, new: 1 } });
    expect(r.g("META-003")).toMatchObject({ change: "new", counts: { ...zero, new: 1 } });
    expect(r.c.scopeMismatch).toBe(false);
    r = await cmp(a2, a3);
    expect(r.g("CNT-005")?.counts).toEqual({ ...zero, persistent: 1, regressed: 1, not_rechecked: 1 });
    expect(r.g("META-003")).toMatchObject({ change: "resolved", counts: { ...zero, resolved: 1 } });
    r = await cmp(a4, a3); // argument order does not matter: always older → newer
    expect(r.c.base.crawlId).toBe(a3);
    expect(r.g("META-003")).toMatchObject({ change: "regressed", counts: { ...zero, regressed: 1 } });
    expect(r.g("CNT-005")?.counts).toEqual({ ...zero, persistent: 2, resolved: 1 });
    expect(Object.values(r.c.totals).reduce((a, b) => a + b, 0)).toBe(r.c.groups.length);
    await expect(compareCrawls(db, a1, other)).rejects.toThrow(/same project/);
    // Different profiles: the comparison still runs, with a scope-mismatch warning.
    await db.execute(sql`update crawls set profile = 'deep' where id = ${a4}::uuid`);
    r = await cmp(a3, a4);
    expect(r.c.scopeMismatch).toBe(true);
    expect(r.c.warnings.join(" ")).toMatch(/different crawl profiles/);

    // An inconclusive result neither resolves nor restarts a finding: it stays open across the gap.
    const q = `p-${randomUUID()}`;
    await audit(q, { "/a": false, "/b": true, "/c": false });
    const q2 = await audit(q, { "/a": false, "/b": true, "/c": false });
    await db.execute(sql`update finding_occurrences set outcome = 'inconclusive' where crawl_id = ${q2}::uuid and rule_id = 'CNT-005'`);
    await writeIssueStates(db, q2, true);
    expect(await stateOf(q2, "/b")).toBe("inconclusive");
    const q3 = await audit(q, { "/a": false, "/b": false, "/c": false }, "User-agent: *\nDisallow: /b\n");
    expect(await stateOf(q3, "/b")).toBe("not_rechecked");
    const q4 = await audit(q, { "/a": false, "/b": true, "/c": false });
    expect(await stateOf(q4, "/b")).toBe("persistent");

    // Re-analysing an earlier audit recomputes the later ones to the same result.
    const before = await Promise.all([a2, a3, a4].map(allStates));
    expect((await analyseCrawl(db, a1, { batchSize: 2 })).outcome).toBe("analysed");
    expect(await Promise.all([a2, a3, a4].map(allStates))).toEqual(before);
  });

  it("a site-rule finding resolves only in a complete crawl that saw at least what the observing audit saw, and answered its URL", { timeout: 90_000 }, async () => {
    const project = `p-${randomUUID()}`;
    const titled = (t: string, path: string) => send(`<!doctype html><html lang="en"><head><title>${t}</title></head><body><main><h1>${t}</h1><p>${words(THIN_WORDS + 50)} ${path}</p></main></body></html>`, "text/html");
    const run = async (robots: string, config: Record<string, unknown> = {}) => {
      srv.routes.set("/robots.txt", send(robots, "text/plain"));
      const c = await newCrawl(db, { siteOrigin: srv.origin, siteId: project, status: "queued", maxDepth: 5, config });
      expect(await runCrawl(opts(), c)).toBe("completed");
      expect((await analyseCrawl(db, c)).outcome).toBe("analysed");
      return c;
    };
    const NAMES_SITEMAP = `User-agent: *\nAllow: /\nSitemap: ${srv.origin}/sitemap.xml\n`;
    srv.routes.set("/", send(`<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p>${words(THIN_WORDS + 50)}</p><a href="/a">a</a><a href="/b">b</a></main></body></html>`, "text/html"));
    srv.routes.set("/a", titled("Same", "/a"));
    srv.routes.set("/b", titled("Same", "/b"));
    srv.routes.set("/sitemap.xml", send(`<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${srv.origin}/</loc></url></urlset>`, "application/xml"));
    // Audit 1: /a and /b share a title (META-004, a site rule, about each page); robots.txt names no sitemap (IDX-027, about robots.txt).
    const a1 = await run("User-agent: *\nAllow: /\n");
    const fpOf = async (rule: string, path: string) => ((await db.execute(sql`select fingerprint from issue_states where crawl_id = ${a1}::uuid and rule_id = ${rule} and url = ${`${srv.origin}${path}`}`)).rows[0] as { fingerprint: string }).fingerprint;
    const fpA = await fpOf("META-004", "/a");
    const fpB = await fpOf("META-004", "/b");
    const fpRobots = await fpOf("IDX-027", "/robots.txt");
    const st = async (c: string, fp: string) => ((await db.execute(sql`select state, page_subject from issue_states where crawl_id = ${c}::uuid and fingerprint = ${fp}`)).rows[0] as { state: string; page_subject: boolean } | undefined);
    expect(await st(a1, fpA)).toEqual({ state: "new", page_subject: true });
    expect(await st(a1, fpRobots)).toEqual({ state: "new", page_subject: false });

    // Audit 2 excludes /b by scope: nothing is left unfetched (complete), but it saw less than audit 1. /a was fetched and
    // no longer has a duplicate in this crawl, yet /b still carries the same title: nothing is fixed. robots.txt now names
    // the sitemap, but a narrower crawl re-checks no site-rule finding, site-wide subjects included.
    const a2 = await run(NAMES_SITEMAP, { scope: { include: [], exclude: ["/b"] } });
    expect((await db.execute(sql`select state from crawl_urls where crawl_id = ${a2}::uuid and normalised_url = ${`${srv.origin}/b`}`)).rows[0]).toEqual({ state: "excluded_by_rule" });
    expect(await st(a2, fpA)).toMatchObject({ state: "not_rechecked" });
    expect(await st(a2, fpB)).toMatchObject({ state: "not_rechecked", page_subject: true });
    expect(await st(a2, fpRobots)).toMatchObject({ state: "not_rechecked", page_subject: false });
    expect((await compareCrawls(db, a1, a2)).groups.find((g) => g.ruleId === "META-004")?.counts).toMatchObject({ resolved: 0, not_rechecked: 2 });
    // A crawl limited to a subfolder (/a…) leaves the rest out_of_scope: just as narrow.
    const a2b = await run(NAMES_SITEMAP, { scope: { include: [], exclude: [], subfolder: "/a" } });
    expect((await db.execute(sql`select normalised_url, state from crawl_urls where crawl_id = ${a2b}::uuid order by 1`)).rows).toContainEqual({ normalised_url: `${srv.origin}/`, state: "out_of_scope" });
    expect(await st(a2b, fpRobots)).toMatchObject({ state: "not_rechecked" });

    // Audit 3 crawls the whole site again with /b retitled: every finding is fixed and re-checked.
    srv.routes.set("/b", titled("Other", "/b"));
    const a3 = await run(NAMES_SITEMAP);
    expect(await st(a3, fpA)).toMatchObject({ state: "resolved" });
    expect(await st(a3, fpB)).toMatchObject({ state: "resolved" });
    expect(await st(a3, fpRobots)).toMatchObject({ state: "resolved" });
    expect((await compareCrawls(db, a1, a3)).groups.find((g) => g.ruleId === "META-004")?.counts).toMatchObject({ resolved: 2, not_rechecked: 0 });
  });
});
