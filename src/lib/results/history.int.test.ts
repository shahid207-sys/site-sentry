// History rules end to end (SITE-004 regressions, SITE-005 new URLs with critical issues): real crawls of a local
// site that changes between four audits of one project.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { testRedis } from "@/test/redis";
import { runCrawl, type RunnerOptions } from "@/lib/crawl/v2/runner";
import { analyseCrawl } from "@/lib/rules/analyse";
import { THIN_WORDS } from "@/lib/rules/cnt";
import { findingFingerprint } from "@/lib/rules/fingerprint";
import type { Health } from "./health";
import { stateCounts } from "./states";

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

const opts = (): RunnerOptions => ({ db, redis, politeness: { keyPrefix: `test:history:${randomUUID()}:` }, fetch: srv.fetch, owner: "test", leaseMs: 30_000 });
// Each page its own vocabulary, so long pages are not near-duplicates of each other (CNT-007).
const words = (n: number, seed: string) => Array.from({ length: n }, (_, i) => `${seed}${i % 97}`).join(" ");
const page = (title: string, thin = false) =>
  send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main><h1>${title}</h1><p>${words(thin ? 20 : THIN_WORDS + 50, title.replace(/\W/g, ""))}</p></main></body></html>`, "text/html; charset=utf-8");

/** One audit of project `project`: /a (thin or not), /b, and the extra linked paths; `gone` paths answer 404. */
async function audit(project: string, s: { thinA: boolean; extra?: string[]; gone?: string[]; robots?: string }): Promise<string> {
  const links = ["/a", "/b", ...(s.extra ?? []), ...(s.gone ?? [])];
  srv.routes.set("/robots.txt", send(s.robots ?? "User-agent: *\nAllow: /\n", "text/plain"));
  srv.routes.set("/", send(`<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p>${words(THIN_WORDS + 50, "home")}</p>${links.map((l) => `<a href="${l}">${l}</a>`).join("")}</main></body></html>`, "text/html"));
  srv.routes.set("/a", page("Page A", s.thinA));
  srv.routes.set("/b", page("Page B"));
  for (const p of s.extra ?? []) srv.routes.set(p, page(`Page ${p}`));
  for (const p of s.gone ?? []) srv.routes.set(p, send("", "text/html", 404));
  const c = await newCrawl(db, { siteOrigin: srv.origin, siteId: project, status: "queued", maxDepth: 5 });
  expect(await runCrawl(opts(), c)).toBe("completed");
  expect((await analyseCrawl(db, c)).outcome).toBe("analysed");
  return c;
}

const home = () => `${srv.origin}/`;
const historyFindings = async (c: string) =>
  (await db.execute(sql`select rule_id, url, evidence from findings where crawl_id = ${c}::uuid and rule_id in ('SITE-004', 'SITE-005') order by rule_id`)).rows as { rule_id: string; url: string; evidence: Record<string, unknown> }[];
const runs = async (c: string) =>
  Object.fromEntries(((await db.execute(sql`select rule_id, status from rule_runs where crawl_id = ${c}::uuid and rule_id in ('SITE-004', 'SITE-005')`)).rows as { rule_id: string; status: string }[]).map((r) => [r.rule_id, r.status]));
const stateOf = async (c: string, rule: string) =>
  ((await db.execute(sql`select state from issue_states where crawl_id = ${c}::uuid and fingerprint = ${findingFingerprint(rule, home(), "")}`)).rows[0] as { state: string } | undefined)?.state;
const groupOf = async (c: string, rule: string) =>
  (await db.execute(sql`select affected_urls, affected_pages, priority from issue_groups where crawl_id = ${c}::uuid and rule_id = ${rule}`)).rows[0] as { affected_urls: number; affected_pages: number; priority: string } | undefined;

describe("history rules", () => {
  it("SITE-004 reports regressions and SITE-005 new URLs with a critical issue, and both resolve when they are gone", { timeout: 90_000 }, async () => {
    const project = `p-${randomUUID()}`;

    // First audit: nothing to compare with, so the history rules do not run.
    const a1 = await audit(project, { thinA: true });
    expect(await runs(a1)).toEqual({});
    expect(await historyFindings(a1)).toEqual([]);

    // Second: /a fixed (resolved, not regressed). /ok is new, and shares the site-wide groups that are Critical on this
    // small http site (SEC-001 no HTTPS, among others): SITE-005 reports it.
    const a2 = await audit(project, { thinA: false, extra: ["/ok"] });
    expect(await runs(a2)).toEqual({ "SITE-004": "ran", "SITE-005": "ran" });
    const f2 = await historyFindings(a2);
    expect(f2.map((f) => f.rule_id)).toEqual(["SITE-005"]);
    expect(f2[0].evidence).toMatchObject({ newUrls: 1, pages: 1, previousAuditId: a1, sample: [`${srv.origin}/ok`] });
    expect(f2[0].evidence.byRule).toHaveProperty("SEC-001", 1);
    const critical = async (c: string) =>
      (await db.execute(sql`select rule_id from issue_groups where crawl_id = ${c}::uuid and priority = 'critical' and rule_id not like 'SITE-%' order by rule_id`)).rows.map((r) => (r as { rule_id: string }).rule_id);
    // Every rule it names is a Critical group of the audit.
    expect(await critical(a2)).toEqual(expect.arrayContaining(Object.keys(f2[0].evidence.byRule as object)));

    // Third: /a thin again (CNT-005 regressed), and three new links answer 404 (IDX-001, impact 5, Critical here).
    const gone = ["/gone1", "/gone2", "/gone3"];
    const a3 = await audit(project, { thinA: true, extra: ["/ok"], gone });
    expect((await groupOf(a3, "IDX-001"))?.priority).toBe("critical");
    const f3 = await historyFindings(a3);
    expect(f3.map((f) => [f.rule_id, f.url])).toEqual([["SITE-004", home()], ["SITE-005", home()]]);
    expect(f3[0].evidence).toEqual({ regressed: 1, pages: 1, byRule: { "CNT-005": 1 }, previousAuditId: a2, sample: [`${srv.origin}/a`] });
    // /ok is not new against the second audit: the new URLs are the three 404s.
    expect(f3[1].evidence).toMatchObject({ newUrls: 3, pages: 3, previousAuditId: a2, sample: gone.map((p) => `${srv.origin}${p}`) });
    expect(f3[1].evidence.byRule).toHaveProperty("IDX-001", 3);
    expect(await stateOf(a3, "SITE-004")).toBe("new");
    expect(await stateOf(a3, "SITE-005")).toBe("persistent"); // one finding per audit, at the home page
    // Reach counts the URLs a history finding stands for.
    expect(await groupOf(a3, "SITE-005")).toMatchObject({ affected_urls: 1, affected_pages: 3 });

    // The analysis summary counts them; the health score leaves them out (the regressed rules already count there).
    const row = (await db.execute(sql`select analysis, health from crawls where id = ${a3}::uuid`)).rows[0] as { analysis: { findings: number; issueGroups: number; states: unknown }; health: Health };
    const n = (q: ReturnType<typeof sql>) => db.execute(q).then((r) => (r.rows[0] as { n: number }).n);
    expect(row.analysis.findings).toBe(await n(sql`select count(*)::int as n from findings where crawl_id = ${a3}::uuid`));
    expect(row.analysis.issueGroups).toBe(await n(sql`select count(*)::int as n from issue_groups where crawl_id = ${a3}::uuid`));
    expect(row.analysis.states).toEqual(await stateCounts(db, a3));
    expect(row.health.categories.site?.rulesRan).toBe(3);

    // A narrower audit (robots.txt blocks /b, which audit 3 answered) re-checks no site-level finding of audit 3:
    // the history findings stay open even though it reports neither.
    const narrow = await audit(project, { thinA: false, extra: ["/ok"], robots: "User-agent: *\nDisallow: /b\n" });
    expect(await historyFindings(narrow)).toEqual([]);
    expect(await stateOf(narrow, "SITE-004")).toBe("not_rechecked");
    expect(await stateOf(narrow, "SITE-005")).toBe("not_rechecked");

    // Fourth: fixed again, the 404s unlinked, no new URL, the whole site crawled. Both history findings resolve.
    const a4 = await audit(project, { thinA: false, extra: ["/ok"] });
    expect(await historyFindings(a4)).toEqual([]);
    expect(await stateOf(a4, "SITE-004")).toBe("resolved");
    expect(await stateOf(a4, "SITE-005")).toBe("resolved");

    // Fifth: /gone1 is linked again. Audit 4 did not have it, but audit 3 did: it is not new.
    const a5 = await audit(project, { thinA: false, extra: ["/ok"], gone: ["/gone1"] });
    expect((await groupOf(a5, "IDX-001"))?.affected_urls).toBe(1);
    // The home page's broken link (LNK-001), resolved in audit 4, is back: a regression. /gone1's 404 is not one:
    // audit 4 did not re-check it, so it stayed open (persistent now).
    const f5 = await historyFindings(a5);
    expect(f5.map((f) => f.rule_id)).toEqual(["SITE-004"]);
    expect(f5[0].evidence).toMatchObject({ regressed: 1, byRule: { "LNK-001": 1 } });
    expect(await stateOf(a5, "SITE-004")).toBe("regressed");

    // Re-analysing an earlier audit rewrites the later audits' history results to the same thing.
    await db.execute(sql`delete from findings where crawl_id = ${a3}::uuid and rule_id = 'SITE-004'`);
    const before = await Promise.all([a2, a3, narrow, a4].map((c) => db.execute(sql`select fingerprint, state from issue_states where crawl_id = ${c}::uuid order by fingerprint`).then((r) => r.rows)));
    expect((await analyseCrawl(db, a1)).outcome).toBe("analysed");
    expect(await historyFindings(a3)).toEqual(f3);
    expect(await Promise.all([a2, a3, narrow, a4].map((c) => db.execute(sql`select fingerprint, state from issue_states where crawl_id = ${c}::uuid order by fingerprint`).then((r) => r.rows)))).toEqual(before);
  });
});
