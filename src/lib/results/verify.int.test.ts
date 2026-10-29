// Fix verification end to end: audit a local site, change it, verify one issue group, and check that only that
// group's fingerprints change state.
import { randomUUID } from "node:crypto";
import type { Queue } from "bullmq";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer, type Handler } from "@/test/local-server";
import { testRedis } from "@/test/redis";
import type { CrawlJob } from "@/lib/crawl/v2/queue";
import { runCrawl, type RunnerOptions } from "@/lib/crawl/v2/runner";
import { analyseCrawl } from "@/lib/rules/analyse";
import { THIN_WORDS } from "@/lib/rules/cnt";
import { findingFingerprint } from "@/lib/rules/fingerprint";
import { compareCrawls, crawlOverview, issueGroups, verificationResult } from "./queries";
import { previousAudit } from "./states";
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

const opts = (): RunnerOptions => ({ db, redis, politeness: { keyPrefix: `test:verify:${randomUUID()}:` }, fetch: srv.fetch, owner: "test", leaseMs: 30_000 });
const enqueued: string[] = [];
const queue = { add: async (_n: string, d: CrawlJob) => void enqueued.push(d.crawlId) } as unknown as Queue<CrawlJob>;
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(" ");
const html = (title: string, thin: boolean, extra = "") =>
  send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${extra}</head><body><main><h1>${title}</h1><p>${words(thin ? 20 : THIN_WORDS + 50)}</p></main></body></html>`, "text/html; charset=utf-8");

type Site = { robots?: string; routes: Record<string, Handler> };
function serve(site: Site) {
  srv.routes.clear();
  srv.routes.set("/robots.txt", send(site.robots ?? "User-agent: *\nAllow: /\n", "text/plain"));
  srv.routes.set("/", send(`<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p>${words(THIN_WORDS + 50)}</p>${["a", "b", "c", "d", "e"].map((p) => `<a href="/${p}">${p}</a>`).join("")}</main></body></html>`, "text/html"));
  for (const [p, h] of Object.entries(site.routes)) srv.routes.set(p, h);
}

async function analysedCrawl(project: string, over: Parameters<typeof newCrawl>[1] = {}): Promise<string> {
  const c = await newCrawl(db, { siteOrigin: srv.origin, siteId: project, status: "queued", maxDepth: 5, ...over });
  expect(await runCrawl(opts(), c)).toBe("completed");
  expect((await analyseCrawl(db, c)).outcome).toBe("analysed");
  return c;
}

/** Every issue_states row of the project's crawls except the given fingerprints. */
const dumpOutside = async (project: string, fps: string[]) =>
  (
    await db.execute(sql`select s.crawl_id, s.fingerprint, s.state, s.outcome from issue_states s join crawls c on c.id = s.crawl_id
      where c.site_id = ${project} and c.kind = 'audit' and not (s.fingerprint = any(${`{${fps.join(",")}}`}::text[])) order by 1, 2`)
  ).rows;

describe("fix verification", () => {
  it("re-checks only the group's URLs and changes only the group's states", async () => {
    const project = `p-${randomUUID()}`;
    const fp = (path: string, rule = "CNT-005") => findingFingerprint(rule, `${srv.origin}${path}`, "");
    // Audit: /a /b /c /d thin (CNT-005); /e carries two titles (META-003), a group verification must not touch.
    serve({ routes: { "/a": html("A", true), "/b": html("B", true), "/c": html("C", true), "/d": html("D", true), "/e": html("E", false, "<title>E again</title>") } });
    const audit = await analysedCrawl(project);
    const targets = ["/a", "/b", "/c", "/d"].map((p) => fp(p));
    const groupBefore = (await issueGroups(db, audit)).find((g) => g.ruleId === "CNT-005")!;
    expect(groupBefore).toMatchObject({ affectedUrls: 4, states: { new: 4 } });

    // Groups a re-fetch cannot judge are refused, not silently "verified".
    await expect(startVerification(db, queue, audit, "LNK-001")).rejects.toThrow(/other pages/);
    await expect(startVerification(db, queue, audit, "SITE-001")).rejects.toThrow(/site rule/);
    await expect(startVerification(db, queue, audit, "IDX-999")).rejects.toThrow(/Unknown rule/);

    // The fix patch: /a fixed; /b not fixed; /c fixed but robots.txt now blocks it; /d fixed by a 301 to /f, a thin
    // page that is not in the group; /e still has two titles.
    serve({
      robots: "User-agent: *\nDisallow: /c\n",
      routes: { "/a": html("A", false), "/b": html("B", true), "/c": html("C", false), "/d": send("", "text/html", 301, { location: "/f" }), "/f": html("F", true), "/e": html("E", false, "<title>E again</title>") },
    });
    const outsideBefore = await dumpOutside(project, targets);
    const started = await startVerification(db, queue, audit, "CNT-005");
    expect(enqueued).toContain(started.verifyCrawlId);
    expect(started.fingerprints).toBe(4);
    expect(started.urls.map((u) => new URL(u).pathname)).toEqual(["/a", "/b", "/c", "/d"]);
    expect(await runCrawl(opts(), started.verifyCrawlId)).toBe("completed");
    // The worker path: the analysis job dispatches a verify crawl itself.
    expect((await analyseCrawl(db, started.verifyCrawlId)).outcome).toBe("analysed");

    // Only the seeds and the redirect target were fetched: no start URL, no sitemap, no links followed.
    const fetched = (await db.execute(sql`select normalised_url, state from crawl_urls where crawl_id = ${started.verifyCrawlId}::uuid and state not in ('depth_exceeded') order by 1`)).rows as { normalised_url: string; state: string }[];
    expect(fetched.map((x) => `${new URL(x.normalised_url).pathname} ${x.state}`)).toEqual(["/a analysed", "/b analysed", "/c blocked_robots", "/d redirected", "/f analysed"]);
    const ran = (await db.execute(sql`select rule_id from rule_runs where crawl_id = ${started.verifyCrawlId}::uuid`)).rows.map((x) => (x as { rule_id: string }).rule_id);
    expect(ran).toEqual(["CNT-005"]);

    const v = await verificationResult(db, started.verifyCrawlId);
    expect(v.urls.map((x) => `${new URL(x.url).pathname} ${x.state}`)).toEqual(["/a resolved", "/b persistent", "/c not_rechecked", "/d resolved"]);
    expect(v.states).toEqual({ resolved: 2, persistent: 1, not_rechecked: 1 });
    // /f is thin, and the verification saw it, but it is not one of the group's fingerprints: no state row.
    const f = (await db.execute(sql`select count(*)::int as n from finding_occurrences where crawl_id = ${started.verifyCrawlId}::uuid and fingerprint = ${fp("/f")}`)).rows[0] as { n: number };
    expect(f.n).toBe(1);
    expect((await db.execute(sql`select count(*)::int as n from issue_states where crawl_id = ${started.verifyCrawlId}::uuid`)).rows[0]).toEqual({ n: 4 });

    // Nothing outside the group changed; the audit shows the verified fixes.
    expect(await dumpOutside(project, targets)).toEqual(outsideBefore);
    const groupAfter = (await issueGroups(db, audit)).find((g) => g.ruleId === "CNT-005")!;
    expect(groupAfter.states).toEqual({ new: 2, resolved: 2 });
    expect((await issueGroups(db, audit)).find((g) => g.ruleId === "META-003")?.states).toEqual({ new: 1 });
    const ov = await crawlOverview(db, audit);
    expect(ov.verifiedResolved).toBe(2);
    // A second verification targets what is still open: /b and /c.
    const again = await startVerification(db, queue, audit, "CNT-005");
    expect(again.urls.map((u) => new URL(u).pathname)).toEqual(["/b", "/c"]);
    await db.execute(sql`delete from crawls where id = ${again.verifyCrawlId}::uuid`);

    // A narrower audit that leaves /d out (scope rule) cannot re-check it, but the verification resolved it after the
    // audit: the comparison shows it resolved (the verification overlay); /c, blocked by robots.txt in both the
    // verification and this audit, stays not_rechecked.
    const narrow = await analysedCrawl(project, { config: { scope: { include: [], exclude: ["/d$"] } } });
    expect((await db.execute(sql`select state from crawl_urls where crawl_id = ${narrow}::uuid and normalised_url = ${`${srv.origin}/d`}`)).rows[0]).toEqual({ state: "excluded_by_rule" });
    const narrowCmp = (await compareCrawls(db, audit, narrow)).groups.find((g) => g.ruleId === "CNT-005");
    expect(narrowCmp?.counts).toMatchObject({ resolved: 2, persistent: 1, not_rechecked: 1, regressed: 0 }); // /a and /d; /b; /c
    expect(narrowCmp?.change).toBe("persistent");

    // Next full audit: /a thin again (verified fixed → regressed), /b still thin (persistent), /c fixed and fetchable
    // (resolved). The verification is history, not the comparison base.
    serve({ routes: { "/a": html("A", true), "/b": html("B", true), "/c": html("C", false), "/d": send("", "text/html", 301, { location: "/f" }), "/f": html("F", true), "/e": html("E", false, "<title>E again</title>") } });
    const next = await analysedCrawl(project);
    expect(await previousAudit(db, next)).toBe(narrow);
    const st = async (crawl: string, path: string) => ((await db.execute(sql`select state from issue_states where crawl_id = ${crawl}::uuid and fingerprint = ${fp(path)}`)).rows[0] as { state: string } | undefined)?.state;
    expect(await st(next, "/a")).toBe("regressed");
    expect(await st(next, "/b")).toBe("persistent");
    expect(await st(next, "/c")).toBe("resolved");
    expect(await st(next, "/d")).toBeUndefined(); // resolved by the verification: not open any more
    const cmp = await compareCrawls(db, audit, next);
    expect(cmp.base.crawlId).toBe(audit);
    // /a was verified fixed and is thin again: regressed, not persistent. /c and /d resolved; /b persistent.
    expect(cmp.groups.find((g) => g.ruleId === "CNT-005")?.counts).toMatchObject({ regressed: 1, persistent: 1, resolved: 2, not_rechecked: 0 });
    await expect(crawlOverview(db, started.verifyCrawlId)).rejects.toThrow(/verification/);

    // Re-analysing the audit recomputes the verification and the next audit to the same rows.
    const all = async () => (await db.execute(sql`select crawl_id, fingerprint, state from issue_states where crawl_id in (${started.verifyCrawlId}::uuid, ${next}::uuid) order by 1, 2`)).rows;
    const before = await all();
    expect((await analyseCrawl(db, audit, { batchSize: 2 })).outcome).toBe("analysed");
    expect(await all()).toEqual(before);
  });
});
