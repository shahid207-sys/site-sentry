// The audit API with CRAWLER_V2=true: create, progress (step), pause/resume/cancel and delete read and write the
// crawls table; the crawl itself runs in-process here, as the worker would run it.
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { workerFetchPolicy } from "@/lib/crawl/v2/fetch-policy";
import { createSafeFetch } from "@/lib/fetch/safe-fetch";
import { runCrawl } from "@/lib/crawl/v2/runner";
import type { AuditSummary } from "@/lib/views";

const db = testDb();
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
};
let r: Routes;

beforeAll(async () => {
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
  };
  // The site is added directly: the public API only accepts ports 80/443/8080/8443, the test server is on a random port.
  const { getStore } = await import("@/lib/workspace");
  await getStore("live").update((d) => {
    d.sites.s1 = { id: "s1", name: "Local", origin, createdAt: new Date().toISOString() };
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

const fetcher = () => createSafeFetch(workerFetchPolicy({ CRAWLER_LOCAL_HOSTS: "site.test=127.0.0.1", CRAWLER_LOCAL_PORTS: String(srv.port) }));
const ctx = <P extends object>(p: P) => ({ params: Promise.resolve({ ws: "live", ...p }) });
const post = (url: string, body?: unknown) => new NextRequest(`http://localhost${url}`, { method: "POST", body: body ? JSON.stringify(body) : undefined });

async function call<T>(res: Response | Promise<Response>): Promise<T> {
  const out = await res;
  const json = await out.json();
  if (out.status >= 400) throw new Error(`${out.status} ${JSON.stringify(json)}`);
  return json as T;
}

async function createAudit(): Promise<AuditSummary> {
  const body = { siteId: "s1", mode: "single", urls: [`${origin}/`], maxPages: 20, maxDepth: 2, categories: ["crawlability"], checkLinks: false, includeImportant: false };
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

    expect(await runCrawl({ db, fetch: fetcher(), owner: "routes-test" }, crawlId)).toBe("completed");
    const after = await step(audit.id);
    expect(after.audit).toMatchObject({
      status: "completed",
      phase: "done",
      crawler: { status: "completed", states: { fetched: 3, blocked_robots: 1 } },
      progress: { planned: 4, done: 4, inspected: 3, skipped: 1, failed: 0 },
    });

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
    expect(await runCrawl({ db, fetch: fetcher(), owner: "routes-test" }, crawlId)).toBe("paused");
    expect((await act("resume")).audit.crawler!.status).toBe("running");
    expect((await act("cancel")).audit.crawler!.status).toBe("cancelling");
    expect(await runCrawl({ db, fetch: fetcher(), owner: "routes-test" }, crawlId)).toBe("cancelled");
    expect((await step(audit.id)).audit).toMatchObject({ status: "cancelled", phase: "done", crawler: { status: "cancelled" } });
  });
});
