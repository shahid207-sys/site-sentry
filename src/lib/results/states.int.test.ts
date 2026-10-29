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
const page = (title: string, thin: boolean) =>
  send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${words(thin ? 20 : THIN_WORDS + 50)}</p></main></body></html>`, "text/html; charset=utf-8");

/** One audit: serve the site as given, crawl it as project `project`, analyse it. */
async function audit(project: string, thin: Record<"/a" | "/b" | "/c", boolean>, robots = "User-agent: *\nAllow: /\n"): Promise<string> {
  srv.routes.set("/robots.txt", send(robots, "text/plain"));
  srv.routes.set("/", send(`<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p>${words(THIN_WORDS + 50)}</p><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></main></body></html>`, "text/html"));
  for (const [path, t] of Object.entries(thin)) srv.routes.set(path, page(`Page ${path}`, t));
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
    const a2 = await audit(project, { "/a": false, "/b": true, "/c": true });
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
    const a4 = await audit(project, { "/a": true, "/b": false, "/c": true });
    expect(await stateOf(a4, "/b")).toBe("resolved");
    expect(await stateOf(a4, "/a")).toBe("persistent");

    // Another project's audits are a separate history.
    const other = await audit(`p-${randomUUID()}`, { "/a": false, "/b": true, "/c": true });
    expect(await stateOf(other, "/b")).toBe("new");
    expect(await stateOf(other, "/a")).toBeUndefined();

    // Re-analysing an earlier audit recomputes the later ones to the same result.
    const before = await Promise.all([a2, a3, a4].map(allStates));
    expect((await analyseCrawl(db, a1, { batchSize: 2 })).outcome).toBe("analysed");
    expect(await Promise.all([a2, a3, a4].map(allStates))).toEqual(before);
  });
});
