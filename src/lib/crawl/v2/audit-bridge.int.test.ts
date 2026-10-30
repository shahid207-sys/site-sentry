import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { testRedis, testThrottlePrefix } from "@/test/redis";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { createAudit } from "../engine";
import { analyseCrawl } from "../../rules/analyse";
import { emptyStore, MemoryStore } from "../../store/store";
import type { Deps } from "../../workflow/deps";
import { controlCrawl, crawlerV2Enabled, startCrawl, syncAudit } from "./audit-bridge";
import { createCrawlQueue } from "./queue";
import { runCrawl } from "./runner";

const db = testDb();
const redis = testRedis();
const throttlePrefix = testThrottlePrefix();
afterAll(() => redis.quit());
process.env.CRAWL_QUEUE_NAME = `crawl-bridge-${randomUUID()}`;
const queue = createCrawlQueue();
let srv: LocalServer;

beforeAll(async () => {
  srv = await startLocalServer();
  srv.routes.set("/", send(`<title>home</title><a href="/a">a</a><a href="/b">b</a>`));
  srv.routes.set("/a", send(`<title>a</title>`));
  srv.routes.set("/b", send(`<title>b</title>`));
});
afterAll(async () => {
  await srv.close();
  await queue.obliterate({ force: true });
  await queue.close();
  await db.$client.end();
});

let store: MemoryStore;
let auditId: string;
beforeEach(async () => {
  store = new MemoryStore(emptyStore());
  await store.update((d) => {
    d.sites.s1 = { id: "s1", name: "Local", origin: srv.origin, createdAt: new Date().toISOString() };
  });
  const deps: Deps = { store, fetch: srv.fetch, now: () => new Date(), newId: () => randomUUID(), source: "live" };
  const { audit } = await createAudit(
    { siteId: "s1", config: { mode: "single", urls: [`${srv.origin}/`], profile: "custom", maxPages: 10, maxDepth: 2, categories: ["crawlability"], checkLinks: false, includeImportant: false } },
    deps,
  );
  auditId = (await startCrawl(db, queue, store, "live", audit, srv.origin)).id;
});
afterEach(() => srv.hits.clear());

const crawlIdOf = async () => (await store.read()).audits[auditId].crawler!.crawlId;
const run = async () => runCrawl({ db, redis, politeness: { keyPrefix: throttlePrefix }, fetch: srv.fetch, owner: "bridge-test" }, await crawlIdOf());

describe("crawler v2 audit bridge", () => {
  it("only applies to the live workspace, and only with CRAWLER_V2=true", () => {
    expect(crawlerV2Enabled("live", { CRAWLER_V2: "true" })).toBe(true);
    expect(crawlerV2Enabled("live", { CRAWLER_V2: "false" })).toBe(false);
    expect(crawlerV2Enabled("live", {})).toBe(false);
    expect(crawlerV2Enabled("sample", { CRAWLER_V2: "true" })).toBe(false);
  });

  it("creates the crawl with the audit's limits and enqueues one job for it", async () => {
    const id = await crawlIdOf();
    const row = (await db.execute(sql`select workspace, audit_id, status, budget, max_depth, config from crawls where id = ${id}::uuid`)).rows[0];
    expect(row).toMatchObject({ workspace: "live", audit_id: auditId, status: "queued", budget: 10, max_depth: 2, config: { seeds: [`${srv.origin}/`] } });
    const job = await queue.getJob(id);
    expect(job?.data).toEqual({ crawlId: id });
  });

  it("mirrors progress and the final status from the crawls table onto the audit", async () => {
    const before = await syncAudit(db, store, auditId);
    expect(before).toMatchObject({ status: "running", phase: "robots", crawler: { status: "queued", states: {} } });
    expect(await run()).toBe("completed");
    const after = await syncAudit(db, store, auditId);
    expect(after).toMatchObject({
      status: "completed",
      phase: "done",
      crawler: { status: "completed", states: { fetched: 3 } },
      progress: { planned: 3, done: 3, inspected: 3, failed: 0, skipped: 0 },
    });
    expect(after.finishedAt).not.toBeNull();
    // The rule analysis runs after the crawl: its status is mirrored too, so the monitor can wait for it.
    expect(after.crawler!.analysis).toBeUndefined();
    expect((await analyseCrawl(db, await crawlIdOf())).outcome).toBe("analysed");
    expect((await syncAudit(db, store, auditId)).crawler!.analysis).toBe("completed");
  });

  it("a crawl failed by a refused stored scope rule shows scope_rule_invalid on the audit", async () => {
    const id = await crawlIdOf();
    await db.execute(sql`update crawls set config = jsonb_set(config, '{scope}', '{"include": ["(a+)+$"], "exclude": []}'::jsonb) where id = ${id}::uuid`);
    expect(await run()).toBe("failed");
    const a = await syncAudit(db, store, auditId);
    expect(a).toMatchObject({ status: "failed", phase: "done", crawler: { status: "failed" }, error: { code: "scope_rule_invalid" } });
    expect(a.error!.message).toMatch(/^Include rule 1 "\(a\+\)\+\$" is refused: /);
    expect(srv.hits.size).toBe(0);
  });

  it("pause, resume and cancel go through crawls.status", async () => {
    const audit = () => store.read().then((d) => d.audits[auditId]);
    await controlCrawl(db, queue, await audit(), "pause");
    expect(await run()).toBe("paused");
    expect(srv.hits.size).toBe(0);
    await expect(controlCrawl(db, queue, await audit(), "pause")).rejects.toMatchObject({ code: "CONFLICT" });

    await controlCrawl(db, queue, await audit(), "resume");
    expect((await syncAudit(db, store, auditId)).crawler!.status).toBe("running");

    await controlCrawl(db, queue, await audit(), "cancel");
    expect(await run()).toBe("cancelled");
    const done = await syncAudit(db, store, auditId);
    expect(done).toMatchObject({ status: "cancelled", phase: "done", crawler: { status: "cancelled" } });
    // Paused before it ever started, so no URL was discovered: nothing to file as cancelled.
    expect(done.crawler!.states).toEqual({});
    // Cancelling again is a no-op, not an error.
    await expect(controlCrawl(db, queue, await audit(), "cancel")).resolves.toBeUndefined();
  });
});
