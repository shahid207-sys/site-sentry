// Scheduled audits against Postgres: claiming due schedules, and the regression alert of a scheduled audit end to end
// (crawl, analyse, compare with the previous audit, signed POST to a local receiver, one delivery row per crawl).
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { testRedis } from "@/test/redis";
import { encryptSecret } from "@/lib/crawl/v2/secrets";
import { runCrawl, type RunnerOptions } from "@/lib/crawl/v2/runner";
import { isBlockedIp } from "@/lib/fetch/ip-guard";
import { DEFAULT_POLICY, type FetchPolicy } from "@/lib/fetch/safe-fetch";
import { analyseCrawl } from "@/lib/rules/analyse";
import { THIN_WORDS } from "@/lib/rules/cnt";
import { SIGNATURE_HEADER, verifySignature, type RegressionAlert } from "./alert";
import { afterAnalysed, MAX_ATTEMPTS, webhookScope } from "./deliver";
import { claimDue, getSchedule, insertSchedule, listDeliveries, recordRun, runNow, setEnabled } from "./store";

const db = testDb();
const redis = testRedis();
afterAll(async () => {
  await db.$client.end();
  await redis.quit();
});

const WS = "test";
const KEY = randomBytes(32);
const env = { CRAWLER_SECRET_KEY: KEY.toString("base64") };
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(" ");
const page = (title: string | null) =>
  send(`<!doctype html><html lang="en"><head><meta charset="utf-8">${title === null ? "" : `<title>${title}</title>`}</head><body><main><h1>Page</h1><p>${words(THIN_WORDS + 50)}</p></main></body></html>`, "text/html; charset=utf-8");

let srv: LocalServer;
let received: { body: string; signature: string | undefined }[];
let hookStatus: number;
let policy: FetchPolicy;
beforeEach(async () => {
  srv = await startLocalServer();
  received = [];
  hookStatus = 200;
  policy = { resolve: async () => ["127.0.0.1"], isBlocked: (ip) => (ip === "127.0.0.1" ? false : isBlockedIp(ip)), allowedPorts: new Set([String(srv.port)]), allowLocalNames: false };
  srv.routes.set("/hook", (req: IncomingMessage, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ body, signature: req.headers[SIGNATURE_HEADER] as string | undefined });
      res.writeHead(hookStatus).end();
    });
  });
});
afterEach(async () => {
  await srv.close();
});

/** Serves the home page and /a, /b; `titled` false drops /a's <title> (a new META issue group). */
function serve(titled: boolean) {
  srv.routes.set("/robots.txt", send("User-agent: *\nAllow: /\n", "text/plain"));
  srv.routes.set("/", send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Home page</title></head><body><main><h1>Home</h1><p>${words(THIN_WORDS + 50)}</p><a href="/a">a</a><a href="/b">b</a></main></body></html>`, "text/html"));
  srv.routes.set("/a", page(titled ? "Page A of the site" : null));
  srv.routes.set("/b", page("Page B of the site"));
}

const opts = (): RunnerOptions => ({ db, redis, politeness: { keyPrefix: `test:schedule:${randomUUID()}:` }, fetch: srv.fetch, owner: "test", leaseMs: 30_000 });

async function audit(project: string, auditId = randomUUID()): Promise<{ crawlId: string; auditId: string }> {
  const crawlId = await newCrawl(db, { workspace: WS, auditId, siteOrigin: srv.origin, siteId: project, status: "queued", maxDepth: 3 });
  expect(await runCrawl(opts(), crawlId)).toBe("completed");
  expect((await analyseCrawl(db, crawlId)).outcome).toBe("analysed");
  return { crawlId, auditId };
}

async function schedule(project: string, webhookUrl: string | null) {
  const id = randomUUID();
  return insertSchedule(
    db,
    { id, workspace: WS, siteId: project, request: { mode: "sitemap" }, cadence: "daily", hourUtc: 6, webhookUrl, webhookSecret: webhookUrl ? encryptSecret("hook-secret", KEY, webhookScope(id)) : null },
    new Date(),
  );
}

/** A scheduled audit: the run row links the schedule to the audit before its crawl is analysed. */
async function scheduledAudit(project: string, scheduleId: string) {
  const auditId = randomUUID();
  await recordRun(db, scheduleId, WS, { auditId });
  return audit(project, auditId);
}

describe("regression alert of a scheduled audit", () => {
  it("skips the first audit, alerts once on a regression with a valid signature, and stays quiet when nothing got worse", async () => {
    const project = `sched-${randomUUID()}`;
    const s = await schedule(project, `${srv.origin}/hook`);
    serve(true);

    const first = await scheduledAudit(project, s.id);
    const o1 = await afterAnalysed(db, first.crawlId, { policy, env, backoffMs: 0 });
    expect(o1).toMatchObject({ status: "skipped", detail: expect.stringMatching(/First analysed audit/) });

    serve(false);
    const second = await scheduledAudit(project, s.id);
    const o2 = await afterAnalysed(db, second.crawlId, { policy, env, backoffMs: 0, appUrl: "https://app.example/" });
    expect(o2.status).toBe("sent");
    expect(received).toHaveLength(1);
    const [hit] = received;
    expect(verifySignature(hit.body, "hook-secret", hit.signature)).toBe(true);
    expect(verifySignature(hit.body, "another-secret", hit.signature)).toBe(false);
    const alert = JSON.parse(hit.body) as RegressionAlert;
    expect(alert.event).toBe("audit.regression");
    expect(alert.audit).toMatchObject({ id: second.auditId, crawlId: second.crawlId, url: `https://app.example/${WS}/audits/${second.auditId}/compare?base=${first.crawlId}` });
    expect(alert.base.crawlId).toBe(first.crawlId);
    expect(alert.groups.length).toBeGreaterThan(0);
    expect(alert.groups.every((g) => g.change === "new" || g.change === "regressed")).toBe(true);
    expect(alert.groups.some((g) => g.ruleId.startsWith("META-"))).toBe(true);

    // A retried analysis job does not alert twice.
    expect(await afterAnalysed(db, second.crawlId, { policy, env, backoffMs: 0 })).toEqual({ status: "none" });
    expect(received).toHaveLength(1);

    // The same site again: nothing new or regressed, so no POST.
    const third = await scheduledAudit(project, s.id);
    expect(await afterAnalysed(db, third.crawlId, { policy, env, backoffMs: 0 })).toMatchObject({ status: "skipped", detail: "No new or regressed issue groups." });
    expect(received).toHaveLength(1);

    const deliveries = await listDeliveries(db, WS, s.id);
    expect(deliveries.map((d) => [d.auditId, d.status])).toEqual([
      [third.auditId, "skipped"],
      [second.auditId, "sent"],
      [first.auditId, "skipped"],
    ]);
    expect(deliveries[1]).toMatchObject({ httpStatus: 200, attempts: 1, baseCrawlId: first.crawlId });
  });

  it("ignores audits no schedule launched", async () => {
    const project = `sched-${randomUUID()}`;
    serve(true);
    const a = await audit(project);
    expect(await afterAnalysed(db, a.crawlId, { policy, env, backoffMs: 0 })).toEqual({ status: "none" });
  });

  it("retries a failing webhook, then records the failure; a private address is refused without a request", async () => {
    const project = `sched-${randomUUID()}`;
    const s = await schedule(project, `${srv.origin}/hook`);
    serve(true);
    await scheduledAudit(project, s.id);
    serve(false);
    hookStatus = 503;
    const b = await scheduledAudit(project, s.id);
    const out = await afterAnalysed(db, b.crawlId, { policy, env, backoffMs: 0 });
    expect(out).toMatchObject({ status: "failed", detail: expect.stringMatching(/HTTP 503.*after 3 attempts/) });
    expect(received).toHaveLength(MAX_ATTEMPTS);

    // The production policy refuses 127.0.0.1 before connecting.
    const project2 = `sched-${randomUUID()}`;
    const s2 = await schedule(project2, `${srv.origin}/hook`);
    serve(true);
    await scheduledAudit(project2, s2.id);
    serve(false);
    received = [];
    const c = await scheduledAudit(project2, s2.id);
    const blocked = await afterAnalysed(db, c.crawlId, { policy: { ...DEFAULT_POLICY, allowedPorts: new Set([String(srv.port)]) }, env, backoffMs: 0 });
    expect(blocked).toMatchObject({ status: "failed", detail: expect.stringMatching(/private or reserved/) });
    expect(received).toHaveLength(0);
    expect((await listDeliveries(db, WS, s2.id))[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("records a regression without a webhook as skipped", async () => {
    const project = `sched-${randomUUID()}`;
    const s = await schedule(project, null);
    serve(true);
    await scheduledAudit(project, s.id);
    serve(false);
    const b = await scheduledAudit(project, s.id);
    const out = await afterAnalysed(db, b.crawlId, { policy, env, backoffMs: 0 });
    expect(out).toMatchObject({ status: "skipped", detail: expect.stringMatching(/no webhook/) });
    expect(out.status !== "none" && out.alert?.groups.length).toBeGreaterThan(0);
  });
});

describe("claimDue", () => {
  it("claims each due schedule once and moves its next run past now", async () => {
    const project = `sched-${randomUUID()}`;
    const now = new Date();
    const a = await schedule(project, null);
    const b = await schedule(project, null);
    const later = await schedule(project, null);
    await runNow(db, WS, a.id, now);
    await runNow(db, WS, b.id, now);
    const paused = await schedule(project, null);
    await runNow(db, WS, paused.id, now);
    await setEnabled(db, WS, paused.id, false, now);

    const [x, y] = await Promise.all([claimDue(db, new Date(now.getTime() + 1000), 50), claimDue(db, new Date(now.getTime() + 1000), 50)]);
    const mine = [...x, ...y].filter((d) => d.siteId === project).map((d) => d.id);
    expect(mine.sort()).toEqual([a.id, b.id].sort());
    for (const id of [a.id, b.id]) {
      const s = (await getSchedule(db, WS, id))!;
      expect(new Date(s.nextRunAt).getTime()).toBeGreaterThan(now.getTime());
      expect(s.lastRunAt).not.toBeNull();
    }
    expect((await getSchedule(db, WS, later.id))!.lastRunAt).toBeNull();
    expect((await claimDue(db, new Date(now.getTime() + 1000), 50)).filter((d) => d.siteId === project)).toEqual([]);
  });

  it("rejects a webhook URL without its secret (check constraint)", async () => {
    await expect(
      db.execute(sql`insert into audit_schedules (workspace, site_id, request, cadence, hour_utc, webhook_url, next_run_at) values (${WS}, 's', '{}'::jsonb, 'daily', 1, 'https://x.test/', now())`),
    ).rejects.toThrow();
  });
});
