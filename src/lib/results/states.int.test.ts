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
});
