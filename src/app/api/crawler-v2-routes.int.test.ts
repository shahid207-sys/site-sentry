// The audit API with CRAWLER_V2=true: create, progress (step), pause/resume/cancel and delete read and write the
// crawls table; the crawl itself runs in-process here, as the worker would run it.
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { testRedis, testThrottlePrefix } from "@/test/redis";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { workerFetchPolicy } from "@/lib/crawl/v2/fetch-policy";
import { createSafeFetch } from "@/lib/fetch/safe-fetch";
import { runCrawl } from "@/lib/crawl/v2/runner";
import type { AuditSummary } from "@/lib/views";

const db = testDb();
const redis = testRedis();
const throttlePrefix = testThrottlePrefix();
afterAll(() => redis.quit());
let srv: LocalServer;
let dataDir: string;
let origin: string;
type Routes = {
  audits: typeof import("./[ws]/audits/route");
  audit: typeof import("./[ws]/audits/[id]/route");
  step: typeof import("./[ws]/audits/[id]/step/route");
  cancel: typeof import("./[ws]/audits/[id]/cancel/route");
  pause: typeof import("./[ws]/audits/[id]/pause/route");
  resume: typeof import("./[ws]/audits/[id]/resume/route");
  quick: typeof import("./[ws]/audits/quick/route");
};
let r: Routes;

/** A random address in the IPv6 documentation range, so each request gets its own rate-limit window. */
const randomIp = () => `2001:db8:${randomBytes(12).toString("hex").match(/.{4}/g)!.join(":")}`;

beforeAll(async () => {
  process.env.TRUSTED_PROXY_HEADER = "x-forwarded-for";
  dataDir = await mkdtemp(path.join(tmpdir(), "ss-v2-routes-"));
  process.env.CRAWLER_V2 = "true";
  process.env.SITE_SENTRY_DATA_DIR = dataDir;
  process.env.CRAWL_QUEUE_NAME = `crawl-routes-${randomUUID()}`;
  srv = await startLocalServer();
  origin = `http://site.test:${srv.port}`;
  srv.routes.set("/", send(`<title>home</title><a href="/a">a</a><a href="/b">b</a><a href="/private/x">x</a>`));
  srv.routes.set("/robots.txt", send("User-agent: *\nDisallow: /private/\n", "text/plain"));
  srv.routes.set("/a", send(`<title>a</title>`));
  srv.routes.set("/b", send(`<title>b</title>`));
  r = {
    audits: await import("./[ws]/audits/route"),
    audit: await import("./[ws]/audits/[id]/route"),
    step: await import("./[ws]/audits/[id]/step/route"),
    cancel: await import("./[ws]/audits/[id]/cancel/route"),
    pause: await import("./[ws]/audits/[id]/pause/route"),
    resume: await import("./[ws]/audits/[id]/resume/route"),
    quick: await import("./[ws]/audits/quick/route"),
  };
  // The site is added directly: the public API only accepts ports 80/443/8080/8443, the test server is on a random port.
  const { getStore } = await import("@/lib/workspace");
  await getStore("live").update((d) => {
    // One site per test below: a site with a running audit gets that audit back instead of a new one.
    for (const id of ["s1", "s2", "s3", "s4", "s5", "s6", "s7"]) d.sites[id] = { id, name: `Local ${id}`, origin, createdAt: new Date().toISOString() };
  });
});
afterAll(async () => {
  const { getCrawlQueue } = await import("@/lib/crawl/v2/audit-bridge");
  await getCrawlQueue().obliterate({ force: true });
  await getCrawlQueue().close();
  await srv.close();
  await db.$client.end();
  await rm(dataDir, { recursive: true, force: true });
});

const fetcher = () => createSafeFetch(workerFetchPolicy({ NODE_ENV: "test", CRAWLER_LOCAL_HOSTS: "site.test=127.0.0.1", CRAWLER_LOCAL_PORTS: String(srv.port) }));
const ctx = <P extends object>(p: P) => ({ params: Promise.resolve({ ws: "live", ...p }) });
const post = (url: string, body?: unknown, headers?: Record<string, string>) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", body: body ? JSON.stringify(body) : undefined, headers });
const base = { mode: "single", urls: [] as string[], categories: ["crawlability"], checkLinks: false, includeImportant: false };
type CrawlRow = { profile: string; budget: number | null; max_depth: number | null; config: Record<string, unknown> };
const crawlRow = async (id: string) => (await db.execute(sql`select profile, budget, max_depth, config from crawls where id = ${id}::uuid`)).rows[0] as CrawlRow;

async function call<T>(res: Response | Promise<Response>): Promise<T> {
  const out = await res;
  const json = await out.json();
  if (out.status >= 400) throw new Error(`${out.status} ${JSON.stringify(json)}`);
  return json as T;
}

async function createAudit(): Promise<AuditSummary> {
  const body = { ...base, siteId: "s1", urls: [`${origin}/`], profile: "custom", budget: 20, maxDepth: 2 };
  const out = await call<{ audit: AuditSummary; reused: boolean }>(r.audits.POST(post("/api/live/audits", body), ctx({})));
  expect(out.reused).toBe(false);
  return out.audit;
}
const step = (id: string) => call<{ audit: AuditSummary; busy: boolean }>(r.step.POST(post(`/api/live/audits/${id}/step`), ctx({ id })));

describe("audit API with CRAWLER_V2=true", () => {
  it("creates a crawl, reports progress from the crawls table, and finishes when the worker finishes", async () => {
    const audit = await createAudit();
    expect(audit.crawler).toMatchObject({ version: 2, status: "queued" });
    const crawlId = audit.crawler!.crawlId;

    const before = await step(audit.id);
    expect(before).toMatchObject({ busy: true, audit: { status: "running", phase: "robots" } });
    expect(srv.hits.size).toBe(0); // the web request did not crawl anything itself

    expect(await runCrawl({ db, redis, politeness: { keyPrefix: throttlePrefix }, fetch: fetcher(), owner: "routes-test" }, crawlId)).toBe("completed");
    const after = await step(audit.id);
    expect(after.audit).toMatchObject({
      status: "completed",
      phase: "done",
      crawler: { status: "completed", states: { fetched: 3, blocked_robots: 1 }, blobMissing: 0 },
      progress: { planned: 4, done: 4, inspected: 3, skipped: 1, failed: 0 },
    });
    // A page whose raw HTML could not be stored is counted on the audit, not hidden.
    await db.execute(sql`update page_snapshots set blob_status = 'blob_missing', raw_html_key = null where id = (select min(id) from page_snapshots where crawl_id = ${crawlId}::uuid)`);
    expect((await step(audit.id)).audit.crawler).toMatchObject({ blobMissing: 1 });

    await call(r.audit.DELETE(new NextRequest(`http://localhost/api/live/audits/${audit.id}`, { method: "DELETE" }), ctx({ id: audit.id })));
    const gone = await db.execute(sql`select count(*)::int as n from crawls where id = ${crawlId}::uuid`);
    expect((gone.rows[0] as { n: number }).n).toBe(0);
  });

  it("pause, resume and cancel write crawls.status, and the audit ends cancelled", async () => {
    const audit = await createAudit();
    const crawlId = audit.crawler!.crawlId;
    const act = (name: "pause" | "resume" | "cancel") =>
      call<{ audit: AuditSummary }>(r[name].POST(post(`/api/live/audits/${audit.id}/${name}`), ctx({ id: audit.id })));

    expect((await act("pause")).audit.crawler!.status).toBe("paused");
    expect(await runCrawl({ db, redis, politeness: { keyPrefix: throttlePrefix }, fetch: fetcher(), owner: "routes-test" }, crawlId)).toBe("paused");
    expect((await act("resume")).audit.crawler!.status).toBe("running");
    expect((await act("cancel")).audit.crawler!.status).toBe("cancelling");
    expect(await runCrawl({ db, redis, politeness: { keyPrefix: throttlePrefix }, fetch: fetcher(), owner: "routes-test" }, crawlId)).toBe("cancelled");
    expect((await step(audit.id)).audit).toMatchObject({ status: "cancelled", phase: "done", crawler: { status: "cancelled" } });
  });
});

describe("audit API crawl profiles", () => {
  // A fresh client IP per call: this describe creates more audits than the general 10-a-minute limit allows one IP.
  const create = (body: Record<string, unknown>) =>
    r.audits.POST(post("/api/live/audits", { ...base, urls: [`${origin}/`], ...body }, { "x-forwarded-for": randomIp() }), ctx({}));

  it("puts the profile's budget and depth on the crawl, and rejects values a fixed profile does not take", async () => {
    const { audit } = await call<{ audit: AuditSummary }>(create({ siteId: "s2", profile: "standard" }));
    expect(audit.config).toMatchObject({ profile: "standard", maxPages: 1000, maxDepth: 10 });
    expect(await crawlRow(audit.crawler!.crawlId)).toMatchObject({ profile: "standard", budget: 1000, max_depth: 10 });

    await expect(call(create({ siteId: "s3", profile: "quick", budget: 500 }))).rejects.toThrow("fixed budget of 25");
    await expect(call(create({ siteId: "s3", profile: "standard", scope: { include: ["/a"], exclude: [] } }))).rejects.toThrow("part of the Custom profile");
    await expect(call(create({ siteId: "s3", profile: "custom", scope: { include: ["("], exclude: [] } }))).rejects.toThrow("Include rule 1:");
    await expect(call(create({ siteId: "s3", profile: "custom", scope: { include: [], exclude: ["/ok/", "(a+)+$"] } }))).rejects.toThrow(
      "Exclude rule 2: Refused: this pattern can take exponential time",
    );
    await expect(call(create({ siteId: "s3", profile: "custom", scope: { include: ["a".repeat(201)], exclude: [] } }))).rejects.toThrow("Include rule 1: Longer than 200 characters.");
    await expect(call(create({ siteId: "s3", profile: "custom", scope: { include: [], exclude: [], subfolder: "blog" } }))).rejects.toThrow("subfolder must be a path");
  });

  it("Full-site takes a budget and no depth limit", async () => {
    const { audit } = await call<{ audit: AuditSummary }>(create({ siteId: "s3", profile: "full", budget: 120_000 }));
    expect(await crawlRow(audit.crawler!.crawlId)).toMatchObject({ profile: "full", budget: 120_000, max_depth: null });
  });

  it("stores the AI crawler intent on the audit and the crawl config, and rejects other values", async () => {
    const { audit } = await call<{ audit: AuditSummary }>(create({ siteId: "s7", profile: "quick", aiCrawlers: "allow" }));
    expect(audit.config).toMatchObject({ aiCrawlers: "allow" });
    expect((await crawlRow(audit.crawler!.crawlId)).config).toMatchObject({ aiCrawlers: "allow" });
    await expect(call(create({ siteId: "s7", profile: "quick", aiCrawlers: "maybe" }))).rejects.toThrow();
  });

  it("stores Custom basic auth encrypted: the password is not in the response, the audit or the crawl row", async () => {
    const password = `pw-${randomUUID()}`;
    const auth = { username: "stage", password };
    delete process.env.CRAWLER_SECRET_KEY;
    const refused = await create({ siteId: "s4", profile: "custom", auth });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.message).toContain("CRAWLER_SECRET_KEY");
    const { getStore } = await import("@/lib/workspace");
    expect(Object.values((await getStore("live").read()).audits).some((a) => a.siteId === "s4")).toBe(false); // nothing left behind

    process.env.CRAWLER_SECRET_KEY = randomBytes(32).toString("base64");
    try {
      const res = await create({ siteId: "s4", profile: "custom", scope: { include: [], exclude: ["/private/"], subfolder: "/" }, auth });
      const text = await res.text();
      expect(res.status).toBe(200);
      expect(text).not.toContain(password);
      const { audit } = JSON.parse(text) as { audit: AuditSummary };
      expect(audit.config).toMatchObject({ profile: "custom", authUser: "stage", scope: { exclude: ["/private/"], subfolder: "/" } });
      expect(JSON.stringify((await getStore("live").read()).audits[audit.id])).not.toContain(password);
      const row = await crawlRow(audit.crawler!.crawlId);
      expect(JSON.stringify(row.config)).not.toContain(password);
      expect(row.config.auth).toMatchObject({ username: "stage", password: expect.stringMatching(/^v1\./) });
    } finally {
      delete process.env.CRAWLER_SECRET_KEY;
    }
  });

  it("the homepage endpoint runs Quick only and allows 5 audits an hour per IP", async () => {
    const ip = randomIp(); // unique per run: the window lives in Redis
    const quick = () => r.quick.POST(post("/api/live/audits/quick", { siteId: "s5", url: `${origin}/` }, { "x-forwarded-for": ip }), ctx({}));
    const first = await call<{ audit: AuditSummary }>(quick());
    expect(first.audit.config).toMatchObject({ profile: "quick", maxPages: 25, maxDepth: 3, mode: "single" });
    expect(await crawlRow(first.audit.crawler!.crawlId)).toMatchObject({ profile: "quick", budget: 25, max_depth: 3 });
    for (let i = 2; i <= 5; i++) expect((await quick()).status).toBe(200); // the running audit is returned again
    const sixth = await quick();
    expect(sixth.status).toBe(429);
    expect((await sixth.json()).error.message).toMatch(/limited to 5 an hour from one address\. Try again in \d+ min\./);
    const other = await r.quick.POST(post("/api/live/audits/quick", { siteId: "s5", url: `${origin}/` }, { "x-forwarded-for": `${ip}, ${randomIp()}` }), ctx({}));
    expect(other.status).not.toBe(429); // the rightmost entry is the client (a fresh one here); the limited ip on its left is ignored
  });

  it("with CRAWLER_V2 off, clamps a profile to the in-request engine and says so on the audit", async () => {
    process.env.CRAWLER_V2 = "false";
    try {
      await expect(call(create({ siteId: "s6", profile: "custom", scope: { include: ["/a"], exclude: [] } }))).rejects.toThrow("need crawler v2");
      const { audit } = await call<{ audit: AuditSummary }>(create({ siteId: "s6", profile: "standard" }));
      expect(audit.crawler).toBeUndefined();
      expect(audit.config).toMatchObject({ profile: "standard", maxPages: 100, maxDepth: 3 });
      const { getStore } = await import("@/lib/workspace");
      expect((await getStore("live").read()).audits[audit.id].coverage).toEqual([
        {
          code: "engine_limit",
          message:
            "The Standard profile asks for 1,000 URLs · 10 clicks deep. The in-request engine running this audit (crawler v2 is off) stops at 100 URLs · 3 clicks deep, so this audit covers at most that.",
        },
      ]);
    } finally {
      process.env.CRAWLER_V2 = "true";
    }
  });
});
