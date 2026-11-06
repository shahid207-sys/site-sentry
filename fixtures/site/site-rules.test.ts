// Fast check of the fixture without a crawl: render every main-host page through the server's router, run the real
// extractor, rebuild what the crawl's site pass computes (link graph: inbound links, click depth, PageRank; template
// groups; the resource phase's answers for images and external links) and run every rule that needs no probe or
// sitemap on it. The findings must equal the declared manifest (defects.ts, defects-2b.ts). The full comparison, with
// probes, sitemaps and the crawler's own states, is scripts/gate-p2a.ts and scripts/gate-p2b.ts.
import { describe, expect, it } from "vitest";
import { parseHtml } from "../../src/lib/audit/parse";
import { cdnManagedReason } from "../../src/lib/crawl/cdn-paths";
import { extractOutlinks } from "../../src/lib/crawl/v2/discovery";
import { crawlView, effectiveCanonical } from "../../src/lib/rules/analyse";
import type { CrawlView, Finding, PageView, ResourceFacts, Rule, SiteCtx, SiteRule, UrlFacts } from "../../src/lib/rules/contract";
import { NEAR_DUPLICATE, NEAR_DUPLICATE_MIN_WORDS } from "../../src/lib/rules/cnt";
import { bfsDepth, pageRank } from "../../src/lib/rules/graph";
import { TemplateGroups } from "../../src/lib/rules/group";
import { RULES } from "../../src/lib/rules/registry";
import { extractHtml } from "../../src/lib/snapshot/extract";
import { imageSize } from "../../src/lib/snapshot/image-size";
import { occurrenceOf, reachBasis, type Occurrence } from "../../src/lib/results/occurrences";
import { clusterTemplates } from "../../src/lib/snapshot/template";
import { simhashSimilarity } from "../../src/lib/snapshot/text";
import { manifestPaths, ROBOTS_BLOCKED_PREFIX } from "./definition";
import { DEFECTS, EXACT_SECTIONS, expectedFindings, findingKey, INDEX_EXTRAS } from "./defects";
import { EXTRAS_2B, KEY_PAGES, MAIN_EXCLUDE, PLAIN_HTTP_PAGE, resourceExpectations, urlOf } from "./defects-2b";
import { gunzipSync } from "node:zlib";
import { ALT3_SITEMAP_URLS, createRouter, encodeForWire, fixtureSitemaps, LASTMOD, LLMS_TXT } from "./server";

const router = createRouter(8080, 8081);
const ORIGIN = router.origins.main;
const MAIN_HOST = new URL(ORIGIN).host;
/** Site rules this test can judge without probes, sitemaps or crawl states (SITE-001 is checked on its own below). */
const SITE_RULES = new Set(["IDX-033", "IDX-034", "LNK-017", "META-004", "META-009", "CNT-006", "CNT-007", "IDX-022", "IDX-023", "LNK-003", "LNK-004", "LNK-005", "LNK-012", "LNK-014", "I18N-001", "I18N-002", "I18N-006"]);
const inSitemap = new Set(fixtureSitemaps().flatMap((s) => s.paths));
const excluded = MAIN_EXCLUDE.map((r) => new RegExp(r.replace(String.raw`\d+`, "8080")));

const routeUrl = (url: string) => {
  const u = new URL(url);
  return router(u.host, u.pathname + u.search, u.protocol === "http:" ? "http" : "https");
};

function render(url: string): PageView | null {
  const r = routeUrl(url);
  if (r.status !== 200 || !r.type.startsWith("text/html")) return null;
  const src = String(r.body);
  const $ = parseHtml(src);
  // The crawler's request accepts gzip, deflate (undici); the server compresses accordingly.
  const headers = { "content-type": r.type, ...encodeForWire(r, "gzip, deflate").headers };
  const x = extractHtml({ $, html: src, pageUrl: url, headers, bytes: Buffer.byteLength(src), outlinks: extractOutlinks($, url).links });
  const path = new URL(url).pathname + new URL(url).search;
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

const t0 = performance.now();
const pages = new Map<string, PageView>();
for (const p of [...manifestPaths(), ...INDEX_EXTRAS.map((e) => e.path), ...EXTRAS_2B, PLAIN_HTTP_PAGE]) {
  if (p.startsWith(ROBOTS_BLOCKED_PREFIX)) continue; // the crawler never fetches them
  const v = render(urlOf(ORIGIN, p));
  if (v) pages.set(v.url, v);
}
// As the site pass does: pages read their template id (clustered shapes) as their fingerprint.
const templateIds = clusterTemplates([...pages.values()].filter((p) => p.facts && p.templateFingerprint).map((p) => ({ url: p.url, fingerprint: p.templateFingerprint!, shape: p.templateShape ?? null })));
for (const p of pages.values()) p.templateFingerprint = templateIds.get(p.url) ?? null;
const renderMs = performance.now() - t0;

// ---------- the site pass: every internal URL a page links to, with what the server answers ----------

const urls: UrlFacts[] = [];
const byUrl = new Map<string, UrlFacts>();
function factsOf(url: string): UrlFacts {
  const known = byUrl.get(url);
  if (known) return known;
  const p = pages.get(url);
  const path = new URL(url).pathname + new URL(url).search;
  const f: UrlFacts = {
    id: urls.length + 1,
    url,
    state: "fetched",
    statusCode: 200,
    redirectTarget: null,
    discoveredVia: inSitemap.has(path) && !url.startsWith("http:") ? ["sitemap"] : ["link"],
    page: p
      ? {
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
          hreflang: p.links.filter((l) => l.via === "hreflang" && l.hreflang).map((l) => ({ lang: l.hreflang!, href: l.href })),
          language: p.language,
          ogLocale: p.facts?.ogLocale ?? null,
          published: p.facts?.published ?? null,
          bodyClass: p.facts?.bodyClass ?? null,
        }
      : null,
    inbound: 0,
    linkDepth: null,
    pagerank: 0,
  };
  urls.push(f);
  byUrl.set(url, f);
  if (p) return f;
  if (excluded.some((r) => r.test(url))) return Object.assign(f, { state: "excluded_by_rule", statusCode: null });
  // As the crawler does: a CDN path is recorded, never fetched.
  if (cdnManagedReason(new URL(url).pathname)) return Object.assign(f, { state: "cdn_managed", statusCode: null });
  const r = routeUrl(url);
  f.statusCode = r.status;
  if (r.status >= 300 && r.status < 400 && r.headers.location) {
    f.state = "redirected";
    f.redirectTarget = new URL(r.headers.location, url).toString();
    factsOf(f.redirectTarget);
  }
  return f;
}
for (const url of pages.keys()) factsOf(url);
const internal = (href: string) => new URL(href).host === MAIN_HOST;
const linkEdges: [number, number][] = [];
for (const p of pages.values()) {
  const from = factsOf(p.url);
  for (const l of p.links) {
    if (internal(l.href) && (l.via === "link" || l.via === "hreflang")) {
      const to = factsOf(l.href);
      if (l.via === "link" && to.url !== p.url) linkEdges.push([from.id - 1, to.id - 1]);
    }
  }
}
// Inbound: distinct linking pages; a link to a redirect counts for its target (analyse.ts does the same in SQL).
const inbound = new Map<number, Set<number>>();
for (const [a, b] of linkEdges) {
  const t = urls[b].state === "redirected" && urls[b].redirectTarget ? byUrl.get(urls[b].redirectTarget!)!.id - 1 : b;
  if (t === a) continue;
  if (!inbound.has(t)) inbound.set(t, new Set());
  inbound.get(t)!.add(a);
}
// Pages linking to this exact URL, with no credit to a redirect target (analyse.ts direct_links).
const direct = new Map<number, Set<number>>();
for (const [a, b] of linkEdges) {
  if (a === b) continue;
  if (!direct.has(b)) direct.set(b, new Set());
  direct.get(b)!.add(a);
}
const adjacency: number[][] = urls.map(() => []);
for (const [a, b] of linkEdges) adjacency[a].push(b);
for (const u of urls) if (u.redirectTarget) adjacency[u.id - 1].push(byUrl.get(u.redirectTarget)!.id - 1);
const depth = bfsDepth(urls.length, adjacency, byUrl.get(`${ORIGIN}/`)!.id - 1);
const rank = pageRank(urls.length, linkEdges).score;
for (const u of urls) Object.assign(u, { directLinks: direct.get(u.id - 1)?.size ?? 0, inbound: inbound.get(u.id - 1)?.size ?? 0, linkDepth: depth[u.id - 1] < 0 ? null : depth[u.id - 1], pagerank: rank[u.id - 1] });
const site = { urls, byUrl };

// ---------- the resource phase: one answer per image and external link ----------

const resources: CrawlView["resources"] = { links: new Map(), images: new Map() };
const resourceOf = (kind: ResourceFacts["kind"], url: string, page: string) => {
  const m = kind === "image" ? resources.images : resources.links;
  const known = m.get(url);
  if (known) return void known.referrers++;
  const r = routeUrl(url);
  const body = typeof r.body === "string" ? Buffer.from(r.body) : r.body;
  const size = kind === "image" && r.status === 200 ? imageSize(body) : null;
  m.set(url, { kind, url, state: "done", skipCode: null, method: "HEAD", status: r.status, contentType: r.type, contentLength: body.length, width: size?.width ?? null, height: size?.height ?? null, error: null, referrers: 1, samplePages: [page] });
};
for (const p of pages.values()) {
  for (const i of p.images) if (i.resolved) resourceOf("image", i.resolved, p.url);
  for (const l of p.links) if (l.via === "link" && !internal(l.href)) resourceOf("external_link", l.href, p.url);
}

const robotsBody = String(router("fixture.test", "/robots.txt").body);
const crawl = crawlView(
  {
    id: "fast",
    site_origin: ORIGIN,
    status: "completed",
    config: { aiCrawlers: "allow", keyPages: KEY_PAGES.map((p) => urlOf(ORIGIN, p)) },
    robots: { url: `${ORIGIN}/robots.txt`, started: true, status: 200, outcome: "parsed", body: robotsBody, sitemaps: [] },
    sitemaps: [],
    probes: [],
    started_at: new Date("2026-06-01T00:00:00Z"),
    created_at: new Date("2026-06-01T00:00:00Z"),
  },
  { complete: true, resources },
);

// ---------- rules ----------

const found = new Map<string, Set<string>>();
const add = (f: Finding) => {
  if (!found.has(f.url)) found.set(f.url, new Set());
  found.get(f.url)!.add(findingKey(f.ruleId, f.outcome));
};
const pageIssues: SiteCtx["pageIssues"] = new Map();
const grouped = new TemplateGroups();
// What the analysis job stores per rule × URL × evidence key (grouped rules: every page), for the fingerprint checks.
const basis = reachBasis(site);
const occurrences: Occurrence[] = [];
const t1 = performance.now();
for (const r of RULES.filter((x) => x.scope === "page")) {
  for (const p of pages.values()) {
    const own = r.evaluate({ page: p, crawl, site });
    for (const f of own) occurrences.push(occurrenceOf(r, f, basis));
    (r.groupByTemplate ? grouped.add(own, p.templateFingerprint) : own).forEach(add);
    for (const f of own) {
      if (f.outcome !== "issue" || !p.templateFingerprint) continue;
      if (!pageIssues.has(r.id)) pageIssues.set(r.id, new Map());
      const t = pageIssues.get(r.id)!.get(p.templateFingerprint) ?? { count: 0, sample: [] };
      t.count++;
      if (t.sample.length < 5) t.sample.push(p.url);
      pageIssues.get(r.id)!.set(p.templateFingerprint, t);
    }
  }
}
grouped.findings().forEach(add);
const record = (r: Rule) => (f: Finding) => {
  add(f);
  occurrences.push(occurrenceOf(r, f, basis));
};
for (const r of RULES) {
  if (r.scope === "site" && SITE_RULES.has(r.id)) r.evaluate({ site, crawl, pageIssues }).forEach(record(r));
  // SITE-001 is checked on its own below; only its occurrences are recorded here.
  if (r.id === "SITE-001") for (const f of (r as SiteRule).evaluate({ site, crawl, pageIssues })) occurrences.push(occurrenceOf(r, f, basis));
  if (r.scope === "resource") for (const x of (r.kind === "image" ? resources.images : resources.links).values()) r.evaluate({ resource: x, crawl }).forEach(record(r));
}
const site001 = RULES.find((r) => r.id === "SITE-001")!.scope === "site" ? (RULES.find((r) => r.id === "SITE-001") as { evaluate(c: SiteCtx): Finding[] }).evaluate({ site, crawl, pageIssues }) : [];
const ruleMs = performance.now() - t1;

/** The rules this test evaluates. */
const judged = (key: string, id = key.split(":")[0]) => {
  const r = RULES.find((x) => x.id === id);
  return r?.scope === "page" || r?.scope === "resource" || SITE_RULES.has(id);
};

describe("fixture site against its manifest (no crawl)", () => {
  it("fingerprints: no two occurrences share one, and a second evaluation gives the same set", () => {
    const seen = new Map<string, string>();
    const clashes: string[] = [];
    for (const o of occurrences) {
      const k = `${o.ruleId} ${o.url} ${o.evidenceKey}`;
      if (seen.has(o.fingerprint) && seen.get(o.fingerprint) !== k) clashes.push(`${seen.get(o.fingerprint)} / ${k}`);
      if (seen.has(o.fingerprint)) clashes.push(`duplicate ${k}`);
      seen.set(o.fingerprint, k);
    }
    expect(clashes).toEqual([]);
    expect(occurrences.length).toBeGreaterThan(500);
    const again: string[] = [];
    for (const r of RULES.filter((x) => x.scope === "page")) for (const p of pages.values()) for (const f of r.evaluate({ page: p, crawl, site })) again.push(occurrenceOf(r, f, basis).fingerprint);
    expect(again.sort()).toEqual(occurrences.filter((o) => RULES.find((r) => r.id === o.ruleId)!.scope === "page").map((o) => o.fingerprint).sort());
  });

  it("renders every manifest page", () => {
    expect(pages.size).toBeGreaterThan(1_000);
    console.log(`rendered and extracted ${pages.size} pages in ${Math.round(renderMs)} ms; ${urls.length} URLs in the graph, ${resources.images.size} images, ${resources.links.size} external links; rules in ${Math.round(ruleMs)} ms`);
  });

  it("every page in the exact sections fires exactly its declared findings", () => {
    const diffs: string[] = [];
    const subjects = new Map<string, string[]>();
    for (const [path, e] of expectedFindings()) subjects.set(urlOf(ORIGIN, path), e);
    const resourceSubjects = resourceExpectations(ORIGIN);
    for (const [url, e] of resourceSubjects) subjects.set(url, e);
    // Anything found inside an exact section is compared too, so an unexpected finding cannot hide.
    const exact = (u: string) => u === `${ORIGIN}/` || EXACT_SECTIONS.some((s) => new URL(u).pathname.startsWith(s));
    for (const u of found.keys()) if (exact(u) && !subjects.has(u)) subjects.set(u, []);
    for (const [url, expected] of subjects) {
      if (!pages.has(url) && !found.has(url) && !resourceSubjects.has(url)) continue; // redirects, error and blocked pages: judged by the gate
      const want = [...new Set(expected.filter((k) => judged(k)))].sort();
      const got = [...(found.get(url) ?? [])].sort();
      const path = url.replace(ORIGIN, "");
      if (want.join() !== got.join()) diffs.push(`${path}: expected [${want}] got [${got}]${DEFECTS[path] ? ` (${DEFECTS[path].name})` : ""}`);
    }
    expect(diffs).toEqual([]);
  });

  it("SITE-001 reports the /products/ template as one group of 300 pages, and nothing else", () => {
    expect(site001.map((f) => ({ ruleId: f.evidence.ruleId, pages: f.evidence.pages, groupSize: f.evidence.groupSize, url: new URL(f.url).pathname.startsWith("/products/") }))).toEqual([
      { ruleId: "IMG-007", pages: 300, groupSize: 300, url: true },
    ]);
  });

  it("clusters the 300 /products/ pages into one template that no other page shares", () => {
    const products = [...pages.values()].filter((p) => new URL(p.url).pathname.startsWith("/products/"));
    const ids = new Set(products.map((p) => p.templateFingerprint));
    expect(products).toHaveLength(300);
    expect(ids.size).toBe(1);
    expect([...pages.values()].filter((p) => ids.has(p.templateFingerprint) && !new URL(p.url).pathname.startsWith("/products/"))).toEqual([]);
  });

  it("the other sections stay silent on content and metadata rules (their defects are later phases)", () => {
    const exact = (p: string) => p === "/" || EXACT_SECTIONS.some((s) => p.startsWith(s));
    const noisy = [...found].filter(([u, ids]) => new URL(u).host === MAIN_HOST && !exact(new URL(u).pathname) && [...ids].some((id) => /^(META|CNT)-/.test(id))).map(([u, ids]) => `${u}: ${[...ids]}`);
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
    const [p8, p9] = [pages.get(`${ORIGIN}/content/p-8`)!, pages.get(`${ORIGIN}/content/p-9`)!];
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

  it("serves the 2b subjects as declared: security headers but not on alt2, the exposed files, a soft-200 on alt3, plain http on one page only", () => {
    expect(router("fixture.test", "/").headers["strict-transport-security"]).toMatch(/max-age=31536000/);
    expect(router("alt2.test", "/").headers["strict-transport-security"]).toBeUndefined();
    expect(String(router("fixture.test", "/.env").body)).toMatch(/^APP_ENV=production\n/);
    expect(String(router("fixture.test", "/.git/HEAD").body)).toBe("ref: refs/heads/main\n");
    expect(router("alt3.test", "/.env")).toMatchObject({ status: 200, type: expect.stringMatching(/^text\/html/) });
    expect(router("fixture.test", PLAIN_HTTP_PAGE, "http").status).toBe(200);
    expect(router("fixture.test", "/clean/", "http").status).toBe(301);
    expect(router("ext2.test", "/gone").status).toBe(404);
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
