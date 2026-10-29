// The report end to end: two real audits of a local site, the report of the second, every number in it checked
// against the database, the site's own text escaped, white-label applied, and the PDF printed.
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { testRedis } from "@/test/redis";
import { runCrawl, type RunnerOptions } from "@/lib/crawl/v2/runner";
import { analyseCrawl } from "@/lib/rules/analyse";
import { THIN_WORDS } from "@/lib/rules/cnt";
import { INLINE_URLS, reportData } from "@/lib/results/report";
import { groupUrlsCsv } from "./csv";
import { renderReport } from "./html";
import { checkReportMetrics, reportMetrics } from "./metrics";
import { pdfPageCount, renderPdf } from "./pdf";

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

const opts = (): RunnerOptions => ({ db, redis, politeness: { keyPrefix: `test:report:${randomUUID()}:` }, fetch: srv.fetch, owner: "test", leaseMs: 30_000 });
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i % 97}`).join(" ");
const THIN = Array.from({ length: INLINE_URLS + 5 }, (_, i) => `/t${String(i).padStart(2, "0")}`);
const XSS = `<script>alert(1)</script>"><img src=x onerror=alert(2)>`;

function serve(fixedThin: number) {
  srv.routes.clear();
  srv.routes.set("/robots.txt", send("User-agent: *\nAllow: /\n", "text/plain"));
  srv.routes.set("/", send(`<!doctype html><html lang="en"><head><title>Home</title></head><body><main><h1>Home</h1><p>${words(THIN_WORDS + 50)}</p>${[...THIN, "/x", "/d1", "/d2"].map((p) => `<a href="${p}">${p}</a>`).join("")}</main></body></html>`, "text/html"));
  THIN.forEach((p, i) => srv.routes.set(p, send(`<!doctype html><html lang="en"><head><title>Page ${p}</title></head><body><main><h1>${p}</h1><p>${words(i < fixedThin ? THIN_WORDS + 50 : 20)}</p></main></body></html>`, "text/html")));
  // The crawled site's own text, hostile: a title and a URL the report must print as text.
  srv.routes.set("/x", send(`<!doctype html><html lang="en"><head><title>${XSS}</title><title>again</title></head><body><main><h1>x</h1><p>${words(THIN_WORDS + 50)}</p></main></body></html>`, "text/html"));
  for (const p of ["/d1", "/d2"]) srv.routes.set(p, send(`<!doctype html><html lang="en"><head><title>Same title</title></head><body><main><h1>${p}</h1><p>${words(THIN_WORDS + 50)} ${p}</p></main></body></html>`, "text/html"));
}

async function analysed(project: string): Promise<string> {
  const c = await newCrawl(db, { siteOrigin: srv.origin, siteId: project, status: "queued", maxDepth: 5 });
  expect(await runCrawl(opts(), c)).toBe("completed");
  expect((await analyseCrawl(db, c)).outcome).toBe("analysed");
  return c;
}

describe("audit report", () => {
  it("prints every number from the database, escapes the site's text, applies white-label, and renders a PDF", { timeout: 180_000 }, async () => {
    const project = `p-${randomUUID()}`;
    serve(0);
    await analysed(project);
    serve(3); // three thin pages fixed: resolved in the second audit
    const crawl = await analysed(project);

    const branding = { agencyName: "Northwind SEO", brandColor: "#0a7d52", logoDataUrl: "data:image/png;base64,iVBORw0KGgo=" };
    const data = await reportData(db, crawl, branding);
    const html = renderReport(data, { csvHref: (r) => `/csv/${r}` });

    // Every number equals its own database query.
    const check = await checkReportMetrics(db, crawl, html);
    expect(check.mismatches, JSON.stringify(check.mismatches)).toEqual([]);
    expect(check.keys).toBeGreaterThan(30);
    const keys = new Set(reportMetrics(html).map((x) => x.key));
    for (const k of ["health.score", "coverage.answered", "coverage.eligible", "group.CNT-005.affected", "group.CNT-005.state.resolved", "compare.persistent", "states.resolved", "depth.1", "duplicates.clusters"]) expect(keys, k).toContain(k);
    expect(reportMetrics(html).find((x) => x.key === "group.CNT-005.state.resolved")?.value).toBe("3");
    expect(reportMetrics(html).find((x) => x.key === "group.CNT-005.affected")?.value).toBe(String(THIN.length - 3));

    // A group over INLINE_URLS lists the first INLINE_URLS and links the CSV.
    expect(data.groups.find((g) => g.ruleId === "CNT-005")!.urls).toHaveLength(INLINE_URLS);
    expect(html).toContain(`href="/csv/CNT-005"`);
    const csv = (await groupUrlsCsv(db, crawl, "CNT-005")).trim().split(String.fromCharCode(13, 10));
    expect(csv[0]).toBe("url,state");
    expect(csv.length - 1).toBe(THIN.length - 3);

    // The site's text is data: escaped, never markup.
    expect(html).not.toContain("<script>alert");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');

    // White-label, and invalid branding ignored rather than injected.
    expect(html).toContain("--brand: #0a7d52");
    expect(html).toContain("Northwind SEO");
    expect(html).toContain(`src="${branding.logoDataUrl}"`);
    const bad = renderReport(await reportData(db, crawl, { brandColor: "red;}</style><script>", logoDataUrl: "https://evil.test/x.png" }), { csvHref: () => "" });
    expect(bad).not.toContain("evil.test");
    expect(bad).not.toContain("red;}");
    expect(bad).toContain("--brand: #1f4b99");

    // The page counter, against documents of known length; then the report itself.
    const pages = (n: number) => `<!doctype html><style>@page{size:A4}div{break-before:page}</style>${Array.from({ length: n }, (_, i) => `<div>${i}</div>`).join("")}`;
    expect((await renderPdf(pages(1))).pages).toBe(1);
    const three = await renderPdf(pages(3));
    expect(three.pages).toBe(3);
    expect(pdfPageCount(three.pdf)).toBe(3);
    const pdf = await renderPdf(html, "Northwind SEO");
    expect(pdf.pdf.subarray(0, 5).toString()).toBe("%PDF-");
    expect(pdf.pages).toBeGreaterThan(5);
  });
});
