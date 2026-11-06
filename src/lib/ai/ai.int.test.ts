// The AI job on a real crawl of a local site, with a fake model: no test spends money or reaches the API.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { testRedis } from "@/test/redis";
import { runCrawl } from "@/lib/crawl/v2/runner";
import { analyseCrawl } from "@/lib/rules/analyse";
import { renderReport } from "../report/html";
import { checkReportMetrics } from "../report/metrics";
import { reportData } from "../results/report";
import { enqueueAiIfEnabled } from "./queue";
import type { AiClient, AiCompletion } from "./run";
import { readAiAnalysis, runAiAnalysis } from "./run";
import type { AiOutput } from "./schema";

const db = testDb();
const redis = testRedis();
let srv: LocalServer;
const FILLER = Array.from({ length: 260 }, (_, i) => `word${i % 97}`).join(" ");
const BUSINESS = { "@context": "https://schema.org", "@type": "LocalBusiness", name: "Acme Signs", address: { "@type": "PostalAddress", addressLocality: "Dubai", addressCountry: "AE" } };
const page = (title: string, body: string, head = "") => `<!doctype html><html lang="en"><head><title>${title}</title>${head}</head><body><nav><a href="/d1">One</a><a href="/d2">Two</a><a href="/">Home</a><a href="/d1">Again</a></nav><main><h1>${title} heading</h1><p>${body}</p></main></body></html>`;

beforeAll(async () => {
  srv = await startLocalServer();
  srv.routes.set("/robots.txt", send("User-agent: *\nAllow: /\n", "text/plain"));
  srv.routes.set("/", send(page("Acme", `We print signs in Dubai. ${FILLER}`, `<meta property="og:title" content="Acme signs"><script type="application/ld+json">${JSON.stringify(BUSINESS)}</script>`), "text/html"));
  for (const p of ["/d1", "/d2"]) srv.routes.set(p, send(page("Same title", `${FILLER} ${p}`), "text/html"));
});
afterAll(async () => {
  await srv.close();
  await db.$client.end();
  await redis.quit();
});

async function analysed(config: Record<string, unknown> = {}): Promise<{ crawlId: string; auditId: string }> {
  const auditId = randomUUID();
  const crawlId = await newCrawl(db, { auditId, siteOrigin: srv.origin, siteId: `p-${randomUUID()}`, status: "queued", maxDepth: 5, config });
  expect(await runCrawl({ db, redis, politeness: { keyPrefix: `test:ai:${randomUUID()}:` }, fetch: srv.fetch, owner: "test", leaseMs: 30_000 }, crawlId)).toBe("completed");
  expect((await analyseCrawl(db, crawlId)).outcome).toBe("analysed");
  return { crawlId, auditId };
}

const FINDING = { findingId: "META-004", url: null, quote: null };
const output = (): AiOutput => ({
  executiveSummary: { strengths: [{ text: "Says what it does.", citations: [{ findingId: null, url: `${srv.origin}/`, quote: "We print signs in Dubai" }] }], weaknesses: [{ text: "Titles repeat.", citations: [FINDING] }] },
  qualityIssues: [],
  rewrites: [{ url: `${srv.origin}/`, title: "Sign printing in Dubai | Acme", description: "Signs printed in Dubai. Ask us for a quote.", h1: "Sign printing", citations: [FINDING] }],
  strategy: [],
  actionPlan: { thisWeek: [{ text: "This will lift your rankings.", citations: [FINDING] }, { text: "Rewrite duplicate titles.", citations: [FINDING] }], thisQuarter: [{ text: "Uncited idea.", citations: [] }] },
});

function fake(answer: Partial<AiCompletion> = {}, tokens = 1_000) {
  const calls: string[] = [];
  const client: AiClient = {
    countTokens: async () => tokens,
    complete: async (req) => {
      calls.push(req.user);
      return { text: JSON.stringify(output()), stopReason: "end_turn", inputTokens: tokens, outputTokens: 500, model: req.model, ...answer };
    },
  };
  return { client, calls };
}

describe("runAiAnalysis", () => {
  it("sends stored data only, drops uncited and banned items, caches by audit, and reports it labelled and in order", { timeout: 120_000 }, async () => {
    const { crawlId, auditId } = await analysed({ brand: "Acme" });
    const f = fake();
    const events: [string, Record<string, unknown> | undefined][] = [];
    expect(await runAiAnalysis(db, crawlId, { client: f.client, env: {}, log: (e, d) => events.push([e, d]) })).toEqual({ status: "done", cached: false });

    const sent = JSON.parse(f.calls[0]);
    expect(sent.issueGroups.map((g: { findingId: string }) => g.findingId)).toContain("META-004");
    expect(sent.pages[0]).toMatchObject({ role: "homepage", title: "Acme", navLinkCount: 3, ogTags: { "og:title": "Acme signs" }, navLabels: [] });
    expect(sent.navLabels).toEqual(["One", "Two", "Home", "Again"]);
    // The model is told where the business is, what it is called, and each page's language.
    expect(sent.brand).toBe("Acme");
    expect(sent.business).toMatchObject({ name: "Acme Signs", locality: "Dubai", country: "AE", sourceUrl: `${srv.origin}/` });
    expect(sent.pages[0]).toHaveProperty("language");
    expect(sent.pages[0].headings).toEqual([{ level: 1, text: "Acme heading" }]);

    const row = await readAiAnalysis(db, auditId);
    expect(row?.model).toBe("gemini-flash-latest");
    expect(row?.analysis?.executiveSummary.strengths).toHaveLength(1);
    expect(row?.analysis?.actionPlan.thisWeek.map((x) => x.text)).toEqual(["Rewrite duplicate titles."]);
    expect(row?.analysis?.actionPlan.thisQuarter).toEqual([]);
    expect(row?.analysis?.rewrites[0]).toMatchObject({ titleChars: 29 });
    expect(row?.dropped).toMatchObject({ items: 2, bannedClaims: 1 });
    expect(events.find(([e]) => e === "ai.grounded")?.[1]).toMatchObject({ items: 2, bannedClaims: 1 });

    const again = fake();
    expect(await runAiAnalysis(db, crawlId, { client: again.client, env: {} })).toEqual({ status: "done", cached: true });
    expect(again.calls).toHaveLength(0);

    const html = renderReport(await reportData(db, crawlId), { csvHref: () => "#" });
    const order = ["Scope", "Executive summary", "Issues", "Rewrites", "Technical checklist", "Action plan"].map((h) => html.indexOf(`<h2>${h}</h2>`));
    expect(order.every((x) => x >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain("AI analysis");
    expect(html).toContain("Sign printing in Dubai | Acme");
    expect(html).toContain("29 characters");
    expect(html).not.toContain("lift your rankings");
    expect((await checkReportMetrics(db, crawlId, html)).mismatches).toEqual([]);
  });

  it("sends nothing without a key or over the cap, and says so", { timeout: 120_000 }, async () => {
    const { crawlId, auditId } = await analysed();
    expect(await runAiAnalysis(db, crawlId, { client: null, env: {} })).toEqual({ status: "not_configured", cached: false });
    expect((await readAiAnalysis(db, auditId))?.detail).toContain("GEMINI_API_KEY");
    const f = fake({}, 10_000);
    expect(await runAiAnalysis(db, crawlId, { client: f.client, env: { AI_MAX_INPUT_TOKENS: "100" } })).toEqual({ status: "over_budget", cached: false });
    expect(f.calls).toHaveLength(0);
    const html = renderReport(await reportData(db, crawlId), { csvHref: () => "#" });
    expect(html).toContain("was not run for this audit");
  });

  it("stores no analysis after a refusal, a cut-off answer, or output that fails validation", { timeout: 120_000 }, async () => {
    const { crawlId, auditId } = await analysed();
    const cases: [Partial<AiCompletion>, string][] = [
      [{ stopReason: "refusal" }, "declined"],
      [{ stopReason: "max_tokens" }, "cut off"],
      [{ text: "Here is my analysis" }, "not JSON"],
      [{ text: JSON.stringify({ executiveSummary: "good" }) }, "schema"],
    ];
    for (const [answer, detail] of cases) {
      expect((await runAiAnalysis(db, crawlId, { client: fake(answer).client, env: {} })).status).toBe("failed");
      const row = await readAiAnalysis(db, auditId);
      expect(row?.analysis).toBeNull();
      expect(row?.detail).toContain(detail);
    }
  });

  it("queues a job only for an audit crawl of a project that turned it on", { timeout: 120_000 }, async () => {
    const queue = { add: async () => undefined } as never;
    const off = await analysed();
    expect(await enqueueAiIfEnabled(db, queue, off.crawlId)).toBe(false);
    expect(await readAiAnalysis(db, off.auditId)).toBeNull();
    const on = await analysed({ aiAnalysis: true });
    expect(await enqueueAiIfEnabled(db, queue, on.crawlId)).toBe(true);
    expect((await readAiAnalysis(db, on.auditId))?.status).toBe("queued");
    await db.execute(sql`update crawls set kind = 'verify' where id = ${on.crawlId}::uuid`);
    expect(await enqueueAiIfEnabled(db, queue, on.crawlId)).toBe(false);
  });
});
