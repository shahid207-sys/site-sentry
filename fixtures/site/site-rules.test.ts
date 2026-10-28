// Fast check of the Phase 2a fixture without a crawl: render every main-host page through the server's router, run
// the real extractor and every page rule (plus the cross-page duplicate rules) on it, and compare with the declared
// manifest in defects.ts. The full comparison, with redirects, probes and every site rule, is scripts/gate-p2a.ts.
import { describe, expect, it } from "vitest";
import { parseHtml } from "../../src/lib/audit/parse";
import { extractOutlinks } from "../../src/lib/crawl/v2/discovery";
import { crawlView, effectiveCanonical } from "../../src/lib/rules/analyse";
import type { Finding, PageView, UrlFacts } from "../../src/lib/rules/contract";
import { NEAR_DUPLICATE, NEAR_DUPLICATE_MIN_WORDS } from "../../src/lib/rules/cnt";
import { RULES } from "../../src/lib/rules/registry";
import { extractHtml } from "../../src/lib/snapshot/extract";
import { simhashSimilarity } from "../../src/lib/snapshot/text";
import { manifestPaths } from "./definition";
import { DEFECTS, EXACT_SECTIONS, expectedFindings, findingKey, INDEX_EXTRAS } from "./defects";
import { gunzipSync } from "node:zlib";
import { ALT3_SITEMAP_URLS, createRouter, fixtureSitemaps, LASTMOD, LLMS_TXT } from "./server";

const router = createRouter(8080, 8081);
const ORIGIN = router.origins.main;
/** Cross-page rules this test can judge from rendered pages alone (no redirects, probes or crawl states). */
const SITE_RULES = new Set(["META-004", "META-009", "CNT-006", "CNT-007", "IDX-022", "IDX-023"]);
const inSitemap = new Set(fixtureSitemaps().flatMap((s) => s.paths));

function render(path: string): PageView | null {
  const r = router("fixture.test", path);
  if (r.status !== 200 || !r.type.startsWith("text/html")) return null;
  const url = new URL(path, ORIGIN).toString();
  const src = String(r.body);
  const $ = parseHtml(src);
  const headers = { "content-type": r.type, ...r.headers };
  const x = extractHtml({ $, html: src, pageUrl: url, headers, bytes: Buffer.byteLength(src), outlinks: extractOutlinks($, url).links });
  return {
    ...x,
    urlId: 0,
    url,
    state: "fetched",
    depth: 1,
    discoveredVia: inSitemap.has(path) ? ["sitemap"] : ["link"],
    html: true,
    requestedUrl: url,
    finalUrl: url,
    statusCode: 200,
    contentType: r.type,
    redirectChain: [],
    headers,
    rawHtmlKey: null,
    bytes: Buffer.byteLength(src),
    truncated: false,
    contentHash: null,
    timings: { fetchMs: 0, extractMs: 0 },
  };
}

const robotsBody = String(router("fixture.test", "/robots.txt").body);
const crawl = crawlView({
  id: "fast",
  site_origin: ORIGIN,
  status: "completed",
  config: { aiCrawlers: "allow" },
  robots: { url: `${ORIGIN}/robots.txt`, started: true, status: 200, outcome: "parsed", body: robotsBody, sitemaps: [] },
  sitemaps: [],
  probes: [],
  started_at: new Date("2026-06-01T00:00:00Z"),
  created_at: new Date("2026-06-01T00:00:00Z"),
});

const paths = [...manifestPaths(), ...INDEX_EXTRAS.map((e) => e.path)];
const t0 = performance.now();
const pages = new Map<string, PageView>();
for (const p of paths) {
  const v = render(p);
  if (v) pages.set(p, v);
}
const renderMs = performance.now() - t0;

const urls: UrlFacts[] = [...pages.values()].map((p, i) => ({
  id: i + 1,
  url: p.url,
  state: p.state,
  statusCode: 200,
  redirectTarget: null,
  discoveredVia: p.discoveredVia,
  page: {
    noindex: !!p.robots && (p.robots.noindex.meta || p.robots.noindex.header),
    canonical: effectiveCanonical(p.canonicals),
    title: p.titles[0] ?? null,
    description: p.descriptions[0] ?? null,
    h1: p.outline.find((h) => h.level === 1)?.text ?? null,
    textHash: p.textHash,
    simhash: p.simhash,
    template: p.templateFingerprint,
    wordCount: p.wordCount,
    ogImage: p.facts?.og.image ?? null,
    icons: p.facts?.icons ?? [],
  },
}));
const site = { urls, byUrl: new Map(urls.map((u) => [u.url, u])) };

const found = new Map<string, Set<string>>();
const t1 = performance.now();
for (const r of RULES) {
  const list: Finding[] = [];
  if (r.scope === "page") for (const p of pages.values()) list.push(...r.evaluate({ page: p, crawl }));
  else if (SITE_RULES.has(r.id)) list.push(...r.evaluate({ site, crawl }));
  for (const f of list) {
    const u = new URL(f.url);
    const key = u.pathname + u.search;
    if (!found.has(key)) found.set(key, new Set());
    found.get(key)!.add(findingKey(f.ruleId, f.outcome));
  }
}
const ruleMs = performance.now() - t1;

/** The rules this test evaluates. */
const judged = (key: string, id = key.split(":")[0]) => RULES.find((r) => r.id === id)?.scope === "page" || SITE_RULES.has(id);

describe("fixture site against its manifest (no crawl)", () => {
  it("renders every manifest page", () => {
    expect(pages.size).toBeGreaterThan(1_000);
    console.log(`rendered and extracted ${pages.size} pages in ${Math.round(renderMs)} ms; page rules + ${SITE_RULES.size} site rules in ${Math.round(ruleMs)} ms`);
  });

  it("every page in the exact sections fires exactly its declared page-level findings", () => {
    const diffs: string[] = [];
    for (const [path, expected] of expectedFindings()) {
      if (!pages.has(path)) continue; // redirects and error pages: judged by the gate
      const want = [...new Set(expected.filter((k) => judged(k)))].sort();
      const got = [...(found.get(path) ?? [])].sort();
      if (want.join() !== got.join()) diffs.push(`${path}: expected [${want}] got [${got}]${DEFECTS[path] ? ` (${DEFECTS[path].name})` : ""}`);
    }
    expect(diffs).toEqual([]);
  });

  it("the other sections stay silent on content and metadata rules (their defects are later phases)", () => {
    const exact = (p: string) => p === "/" || EXACT_SECTIONS.some((s) => p.startsWith(s));
    const noisy = [...found].filter(([p, ids]) => !exact(p) && [...ids].some((id) => /^(META|CNT)-/.test(id))).map(([p, ids]) => `${p}: ${[...ids]}`);
    expect(noisy).toEqual([]);
  });

  it("clean pages stay under the near-duplicate threshold, and the declared near-duplicate pair is above it", () => {
    const declared = new Set(["/content/p-6", "/content/p-7", "/content/p-8", "/content/p-9"]);
    // The pages CNT-007 compares: indexable, hashed, and with enough main-content words.
    const cmp = urls.filter((u) => u.page?.simhash && !u.page.noindex && u.page.wordCount >= NEAR_DUPLICATE_MIN_WORDS && !declared.has(new URL(u.url).pathname));
    let best = { sim: 0, a: "", b: "" };
    for (let i = 0; i < cmp.length; i++)
      for (let j = i + 1; j < cmp.length; j++) {
        const sim = simhashSimilarity(cmp[i].page!.simhash!, cmp[j].page!.simhash!);
        if (sim > best.sim) best = { sim, a: new URL(cmp[i].url).pathname, b: new URL(cmp[j].url).pathname };
      }
    let clean = { sim: 0, a: "", b: "" };
    const cleanOnly = cmp.filter((u) => new URL(u.url).pathname.startsWith("/clean/"));
    for (let i = 0; i < cleanOnly.length; i++)
      for (let j = i + 1; j < cleanOnly.length; j++) {
        const sim = simhashSimilarity(cleanOnly[i].page!.simhash!, cleanOnly[j].page!.simhash!);
        if (sim > clean.sim) clean = { sim, a: new URL(cleanOnly[i].url).pathname, b: new URL(cleanOnly[j].url).pathname };
      }
    console.log(`closest pair of ${cmp.length} compared pages: ${best.a} ~ ${best.b} at ${best.sim.toFixed(3)}; within /clean/ (${cleanOnly.length} pages): ${clean.a} ~ ${clean.b} at ${clean.sim.toFixed(3)} (threshold ${NEAR_DUPLICATE})`);
    expect(best.sim).toBeLessThan(NEAR_DUPLICATE);
    const [p8, p9] = [pages.get("/content/p-8")!, pages.get("/content/p-9")!];
    expect(Math.min(p8.wordCount, p9.wordCount)).toBeGreaterThanOrEqual(NEAR_DUPLICATE_MIN_WORDS);
    const near = simhashSimilarity(p8.simhash!, p9.simhash!);
    console.log(`declared near-duplicate pair /content/p-8 ~ /content/p-9 at ${near.toFixed(3)}`);
    expect(near).toBeGreaterThanOrEqual(NEAR_DUPLICATE);
  });

  it("answers each host as declared: www 301, alt 503 robots, alt2 www 200 without favicon, alt3 oversized sitemap and HTML llms.txt", () => {
    const www = router("www.fixture.test:8080", "/meta/?x=1");
    expect([www.status, www.headers.location]).toEqual([301, `${ORIGIN}/meta/?x=1`]);
    expect(router("alt.test", "/robots.txt").status).toBe(503);
    expect(String(router("alt2.test", "/robots.txt").body)).not.toMatch(/sitemap/i);
    expect(router("www.alt2.test", "/").status).toBe(200);
    expect(router("alt2.test", "/favicon.ico").status).toBe(404);
    const xml = gunzipSync(router("alt3.test", "/sitemap.xml.gz").body as Buffer).toString();
    expect(xml.match(/<loc>/g)).toHaveLength(ALT3_SITEMAP_URLS);
    expect(router("alt3.test", "/llms.txt").type).toMatch(/^text\/html/);
    expect(String(router("fixture.test", "/llms.txt").body)).toBe(LLMS_TXT);
    expect(router("fixture.test", "/assets/og-missing.png").status).toBe(404);
  });

  it("writes one lastmod for the whole /index/ sitemap and a future one for the noindex sitemap", () => {
    const xml = (p: string) => gunzipSync(router("fixture.test", p).body as Buffer).toString();
    const dates = (p: string) => [...xml(p).matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]);
    expect(new Set(dates("/sitemaps/index.xml.gz"))).toEqual(new Set([LASTMOD.identical]));
    expect(new Set(dates("/sitemaps/index-noindex.xml.gz"))).toEqual(new Set([LASTMOD.future]));
    const clean = dates("/sitemaps/clean.xml.gz");
    expect(new Set(clean).size).toBe(clean.length);
    expect(dates("/sitemaps/meta.xml.gz")).toEqual([]);
  });
});
