// Share links end to end over a real analysed audit: password, expiry, revocation, the token never stored.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { testRedis } from "@/test/redis";
import { runCrawl, type RunnerOptions } from "@/lib/crawl/v2/runner";
import { analyseCrawl } from "@/lib/rules/analyse";
import { createShare, listShares, revokeShare, serveShare, SHARE_COOKIE, type ShareRequest } from "./shares";

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

const opts = (): RunnerOptions => ({ db, redis, politeness: { keyPrefix: `test:shares:${randomUUID()}:` }, fetch: srv.fetch, owner: "test", leaseMs: 30_000 });
const branding = async () => ({ agencyName: "Northwind SEO" });
const get = (cookie?: string, want: ShareRequest["want"] = { report: true }): ShareRequest => ({ method: "GET", want, cookie, secure: true });
const post = (password: string): ShareRequest => ({ method: "POST", want: { report: true }, password, secure: true });
const cookieOf = (setCookie: string) => setCookie.split(";")[0].split("=")[1];

describe("report share links", () => {
  it("opens with the right password, refuses a wrong one, and stops working once expired or revoked", { timeout: 120_000 }, async () => {
    srv.routes.set("/robots.txt", send("User-agent: *\nAllow: /\n", "text/plain"));
    srv.routes.set("/", send(`<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p>short</p><a href="/a">a</a></main></body></html>`, "text/html"));
    srv.routes.set("/a", send(`<!doctype html><html lang="en"><head><title>A</title></head><body><main><h1>A</h1><p>short</p></main></body></html>`, "text/html"));
    const crawl = await newCrawl(db, { siteOrigin: srv.origin, siteId: `p-${randomUUID()}`, status: "queued" });
    expect(await runCrawl(opts(), crawl)).toBe("completed");
    expect((await analyseCrawl(db, crawl)).outcome).toBe("analysed");
    const ws = (await db.execute(sql`select workspace from crawls where id = ${crawl}::uuid`)).rows[0] as { workspace: string };
    const base = { workspace: ws.workspace, auditId: `audit-${randomUUID()}`, crawlId: crawl };

    // Inputs are checked.
    await expect(createShare(db, { ...base, password: "short" })).rejects.toThrow(/at least 8/);
    await expect(createShare(db, { ...base, expiresInDays: 0 })).rejects.toThrow(/1 to 365/);
    await expect(createShare(db, { ...base, workspace: "sample" })).rejects.toThrow(/not found/i);

    const share = await createShare(db, { ...base, password: "correct horse", expiresInDays: 7 });
    expect(share.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(share.path).toBe(`/r/${share.token}`);
    // Neither the token nor the password is stored.
    const stored = JSON.stringify((await db.execute(sql`select * from report_shares where id = ${share.id}::uuid`)).rows[0]);
    expect(stored).not.toContain(share.token);
    expect(stored).not.toContain("correct horse");
    expect((await listShares(db, base.workspace, base.auditId))[0]).toMatchObject({ id: share.id, hasPassword: true, revokedAt: null });

    // Without the password: the form, never the report.
    let r = await serveShare(db, share.token, get(), branding);
    expect(r.status).toBe(401);
    expect(r.body).toContain('type="password"');
    expect(r.body).not.toContain("data-metric");
    // Wrong password.
    r = await serveShare(db, share.token, post("wrong password"), branding);
    expect(r.status).toBe(401);
    expect(r.body).toContain("not right");
    expect(r.headers["set-cookie"]).toBeUndefined();
    // A made-up cookie.
    expect((await serveShare(db, share.token, get("x".repeat(43)), branding)).status).toBe(401);
    // Right password: a path-scoped, HttpOnly cookie, then the report.
    r = await serveShare(db, share.token, post("correct horse"), branding);
    expect(r.status).toBe(303);
    expect(r.headers.location).toBe(share.path);
    expect(r.headers["set-cookie"]).toMatch(new RegExp(`^${SHARE_COOKIE}=[A-Za-z0-9_-]{43}; Path=/r/${share.token}; HttpOnly; SameSite=Strict; Max-Age=\\d+; Secure$`));
    const cookie = cookieOf(r.headers["set-cookie"]);
    r = await serveShare(db, share.token, get(cookie), branding);
    expect(r.status).toBe(200);
    expect(r.body).toContain("data-metric");
    expect(r.body).toContain("Northwind SEO");
    expect(r.body).toContain('<meta name="robots" content="noindex, nofollow">');
    const csv = await serveShare(db, share.token, get(cookie, { csv: "CNT-005" }), branding);
    expect(csv.status).toBe(200);
    expect(csv.body.split("\r\n")[0]).toBe("url,state");
    expect((await serveShare(db, share.token, get(undefined, { csv: "CNT-005" }), branding)).status).toBe(401);

    // The cookie of one link opens nothing else.
    const other = await createShare(db, { ...base, password: "correct horse" });
    expect((await serveShare(db, other.token, get(cookie), branding)).status).toBe(401);
    // A link without a password opens directly.
    const open = await createShare(db, base);
    expect(open.expiresAt).toBeNull();
    expect((await serveShare(db, open.token, get(), branding)).status).toBe(200);

    // Expired (by the database clock): refused even with the right cookie.
    await db.execute(sql`update report_shares set expires_at = now() - interval '1 second' where id = ${share.id}::uuid`);
    r = await serveShare(db, share.token, get(cookie), branding);
    expect(r.status).toBe(410);
    expect(r.body).toContain("expired");
    expect((await serveShare(db, share.token, post("correct horse"), branding)).status).toBe(410);
    // Revoked.
    expect(await revokeShare(db, base.workspace, base.auditId, open.id)).toBe(true);
    expect((await serveShare(db, open.token, get(), branding)).status).toBe(410);
    // Unknown and malformed tokens.
    expect((await serveShare(db, "A".repeat(43), get(), branding)).status).toBe(404);
    expect((await serveShare(db, "../../etc", get(), branding)).status).toBe(404);

    // Every answer, refusals included, is noindex and uncached.
    for (const x of [r, await serveShare(db, share.token, get(), branding), await serveShare(db, "bad", get(), branding)]) {
      expect(x.headers["x-robots-tag"]).toMatch(/noindex/);
      expect(x.headers["cache-control"]).toBe("private, no-store");
      expect(x.headers["content-security-policy"]).toMatch(/default-src 'none'/);
    }
  });
});
