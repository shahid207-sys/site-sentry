// Triage end to end: set board columns and per-issue calls on a real audit, check the audit log, that triage never
// changes issue states or counts, and that only a fix verification moves a card to Verified.
import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { testRedis } from "@/test/redis";
import type { CrawlJob } from "@/lib/crawl/v2/queue";
import { runCrawl, type RunnerOptions } from "@/lib/crawl/v2/runner";
import { analyseCrawl } from "@/lib/rules/analyse";
import { THIN_WORDS } from "@/lib/rules/cnt";
import { crawlOverview, issueGroups } from "./queries";
import { auditTriage, fixBoard, setTriage, triageLog } from "./triage";
import { startVerification } from "./verify";

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

const opts = (): RunnerOptions => ({ db, redis, politeness: { keyPrefix: `test:triage:${randomUUID()}:` }, fetch: srv.fetch, owner: "test", leaseMs: 30_000 });
const queue = { add: async () => undefined } as unknown as Queue<CrawlJob>;
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(" ");
const page = (title: string, n: number, head = "") =>
  send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body><main><h1>${title}</h1><p>${words(n)}</p></main></body></html>`, "text/html; charset=utf-8");

function serve(thinA: boolean) {
  srv.routes.clear();
  srv.routes.set("/robots.txt", send("User-agent: *\nAllow: /\n", "text/plain"));
  srv.routes.set("/", send(`<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p>${words(THIN_WORDS + 50)}</p><a href="/a">a</a><a href="/b">b</a><a href="/e">e</a></main></body></html>`, "text/html"));
  srv.routes.set("/a", page("A", thinA ? 20 : THIN_WORDS + 50));
  srv.routes.set("/b", page("B", 20));
  srv.routes.set("/e", page("E", THIN_WORDS + 50, "<title>E again</title>"));
}

describe("triage", () => {
  it("records decisions with an audit log, never changes results, and only verification earns Verified", async () => {
    const project = `p-${randomUUID()}`;
    serve(true);
    const audit = await newCrawl(db, { siteOrigin: srv.origin, siteId: project, status: "queued", maxDepth: 5 });
    expect(await runCrawl(opts(), audit)).toBe("completed");
    expect((await analyseCrawl(db, audit)).outcome).toBe("analysed");
    const groupsBefore = await issueGroups(db, audit);
    const overviewBefore = await crawlOverview(db, audit);
    const thin = (await db.execute(sql`select fingerprint, url from issue_states where crawl_id = ${audit}::uuid and rule_id = 'CNT-005' order by url`)).rows as { fingerprint: string; url: string }[];
    expect(thin.map((x) => new URL(x.url).pathname)).toEqual(["/a", "/b"]);

    // Validation: statuses per subject kind, a reason for ignored, subjects of this audit only.
    await expect(setTriage(db, audit, ["rule:CNT-005"], { status: "fixed" }, "test")).rejects.toThrow(/column/);
    await expect(setTriage(db, audit, [`fp:${thin[0].fingerprint}`], { status: "in_progress" }, "test")).rejects.toThrow(/todo, fixed or ignored/);
    await expect(setTriage(db, audit, [`fp:${thin[0].fingerprint}`], { status: "ignored" }, "test")).rejects.toThrow(/why/);
    await expect(setTriage(db, audit, ["rule:IDX-001"], { status: "ready" }, "test")).rejects.toThrow(/Not part of this audit/);
    await expect(setTriage(db, audit, ["fp:nope"], { status: "fixed" }, "test")).rejects.toThrow(/Not part of this audit/);
    await expect(setTriage(db, audit, ["other"], { status: "todo" }, "test")).rejects.toThrow(/Unknown subject/);
    expect(await auditTriage(db, audit)).toEqual([]);

    // Board columns and per-issue calls, with the log.
    await setTriage(db, audit, ["rule:CNT-005"], { status: "in_progress", assignee: "Dev A" }, "test");
    await setTriage(db, audit, ["rule:CNT-005"], { status: "ready" }, "test");
    await setTriage(db, audit, [`fp:${thin[1].fingerprint}`], { status: "ignored", note: "Landing stub, by design" }, "test");
    const entries = await auditTriage(db, audit);
    expect(entries.map((e) => [e.subject, e.status, e.assignee, e.note])).toEqual([
      [`fp:${thin[1].fingerprint}`, "ignored", null, "Landing stub, by design"],
      ["rule:CNT-005", "ready", "Dev A", null],
    ]);
    const log = await triageLog(db, audit, "rule:CNT-005");
    expect(log.map((e) => [e.before?.status ?? null, e.after.status, e.after.assignee])).toEqual([
      ["in_progress", "ready", "Dev A"],
      [null, "in_progress", "Dev A"],
    ]);
    const board = await fixBoard(db, audit);
    expect(board.find((c) => c.ruleId === "CNT-005")).toMatchObject({ column: "ready", assignee: "Dev A", open: 2, verified: 0 });
    expect(board.find((c) => c.ruleId === "META-003")).toMatchObject({ column: "todo", open: 1 });

    // Triage is a claim: groups, states, counts and health are exactly as the crawl left them.
    expect(await issueGroups(db, audit)).toEqual(groupsBefore);
    expect(await crawlOverview(db, audit)).toEqual(overviewBefore);

    // Verification fixes /a but /b stays thin: still open, not Verified. Once both are fixed, Verified.
    serve(false);
    const v1 = await startVerification(db, queue, audit, "CNT-005");
    expect(await runCrawl(opts(), v1.verifyCrawlId)).toBe("completed");
    expect((await analyseCrawl(db, v1.verifyCrawlId)).outcome).toBe("analysed");
    expect((await fixBoard(db, audit)).find((c) => c.ruleId === "CNT-005")).toMatchObject({ column: "ready", open: 1, verified: 1 });
    srv.routes.set("/b", page("B", THIN_WORDS + 50));
    const v2 = await startVerification(db, queue, audit, "CNT-005");
    expect(await runCrawl(opts(), v2.verifyCrawlId)).toBe("completed");
    expect((await analyseCrawl(db, v2.verifyCrawlId)).outcome).toBe("analysed");
    expect((await fixBoard(db, audit)).find((c) => c.ruleId === "CNT-005")).toMatchObject({ column: "verified", open: 0, verified: 2 });

    // The next audit of the project sees the same triage (it is kept per project).
    const next = await newCrawl(db, { siteOrigin: srv.origin, siteId: project, status: "queued", maxDepth: 5 });
    expect(await runCrawl(opts(), next)).toBe("completed");
    expect((await analyseCrawl(db, next)).outcome).toBe("analysed");
    expect((await auditTriage(db, next)).map((e) => e.subject)).toEqual(entries.map((e) => e.subject));
  });
});
