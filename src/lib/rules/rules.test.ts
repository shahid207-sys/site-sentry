// Every catalog rule: one positive case (fires) and one negative case (silent), plus a clean page and a clean
// site that no rule fires on. Pages are built by the real extractor from HTML, so these also exercise extraction.
import { describe, expect, it } from "vitest";
import { parseHtml } from "../audit/parse";
import { extractOutlinks, type SitemapDocRecord } from "../crawl/v2/discovery";
import type { RobotsRecord } from "../crawl/v2/runner";
import type { DiscoverySource, UrlState } from "../crawl/v2/types";
import { extractHtml } from "../snapshot/extract";
import { crawlView, effectiveCanonical } from "./analyse";
import { NeedsConfig, type CrawlView, type Finding, type PageView, type ResourceFacts, type Rule, type SiteCtx, type SiteView, type UrlFacts } from "./contract";
import { LEGACY_TO_CATALOG } from "./legacy-map";
import type { ProbeRecord } from "./probe-types";
import { DEFERRED_RULES, RULES, RULES_BY_ID } from "./registry";
import { NEAR_DUPLICATE, NEAR_DUPLICATE_MIN_WORDS } from "./cnt";
import { simhash, simhashSimilarity } from "../snapshot/text";
import { paragraph } from "../../../fixtures/site/text";
import { ENGLISH_PROSE, MIXED_PROSE } from "../../../fixtures/site/defects";
import { LANGUAGE_MIN_ACCURACY } from "./meta";
import { meaningfulTerms } from "./util";

const ORIGIN = "https://a.test";
const U = (path: string) => new URL(path, ORIGIN).toString();

// ~230 words of ordinary English, unique to this file.
const TEXT = `A good spade lasts for decades when the blade is cleaned after each use and the handle is oiled before winter.
Gardeners who work heavy clay prefer a narrow blade, because it slices through wet soil without lifting a whole slab at once.
Light sandy beds need less force, so a wider border spade moves more earth with every stroke and saves the back.
Forks are better than spades for lifting potatoes, dividing perennials and turning compost, since the tines leave tubers intact.
Look for a fork forged from one piece of steel; welded tines snap at the joint the first time they meet a buried root.
Hand trowels earn their place in raised beds and containers, where a long tool would knock over seedlings.
A trowel with a depth scale stamped on the blade makes bulb planting quicker, because each hole can be measured in passing.
Pruning shears come in two styles: bypass blades cut like scissors and suit living stems, while anvil blades crush dead wood.
Keep the shears sharp with a small diamond file, and wipe the blades with alcohol between plants to avoid spreading disease.
Watering cans with a long spout reach the back of a border without trampling the front row of plants.
A brass rose gives a fine spray that settles seed compost instead of washing it away.
Finally, store every tool dry, off the floor and out of direct sun, and most of them will outlive the gardener who bought them.`;

interface Parts {
  lang: string;
  charset: string;
  title: string;
  description: string;
  viewport: string;
  canonical: string;
  social: string;
  head: string;
  h1: string;
  body: string;
}
const clean = (path: string): Parts => ({
  lang: ' lang="en"',
  charset: '<meta charset="utf-8">',
  title: "<title>Choosing Garden Tools That Last | Fixture Site</title>",
  description: '<meta name="description" content="How to choose spades, forks, trowels and shears that last for decades, and how to look after them through every season.">',
  viewport: '<meta name="viewport" content="width=device-width, initial-scale=1">',
  canonical: `<link rel="canonical" href="${U(path)}">`,
  social: `<meta property="og:title" content="Garden tools"><meta property="og:image" content="${U("/og.png")}"><meta property="og:url" content="${U(path)}"><meta name="twitter:card" content="summary_large_image">`,
  head: "",
  h1: "<h1>Garden tools for every bed</h1>",
  body: `<main><p>${TEXT}</p><h2>Care</h2><p>Oil the handles.</p></main>`,
});
const html = (p: Parts) =>
  `<!doctype html><html${p.lang}><head>${p.charset}${p.title}${p.description}${p.viewport}${p.canonical}${p.social}${p.head}</head><body>${p.h1}${p.body}</body></html>`;

interface PageOpts {
  status?: number;
  headers?: Record<string, string>;
  via?: DiscoverySource[];
  state?: UrlState;
}
function pageFrom(path: string, over: Partial<Parts> | string = {}, o: PageOpts = {}): PageView {
  const url = U(path);
  const src = typeof over === "string" ? over : html({ ...clean(path), ...over });
  const $ = parseHtml(src);
  const headers = { "content-type": "text/html; charset=utf-8", ...o.headers };
  const x = extractHtml({ $, html: src, pageUrl: url, headers, bytes: Buffer.byteLength(src), outlinks: extractOutlinks($, url).links });
  return {
    ...x,
    urlId: 1,
    url,
    state: o.state ?? "fetched",
    depth: 0,
    discoveredVia: o.via ?? ["link"],
    html: true,
    requestedUrl: url,
    finalUrl: url,
    statusCode: o.status ?? 200,
    contentType: "text/html",
    redirectChain: [],
    headers,
    rawHtmlKey: null,
    bytes: Buffer.byteLength(src),
    truncated: false,
    contentHash: null,
    timings: { fetchMs: 1, extractMs: 1 },
  };
}
/** A response without an HTML body (error, redirect). */
function bare(path: string, status: number, o: PageOpts = {}): PageView {
  const p = pageFrom(path, "", o);
  return { ...p, statusCode: status, html: false, facts: null, robots: null, language: null, titles: [], descriptions: [], outline: [], canonicals: [], mainText: "", wordCount: 0 };
}

/** Graph metrics of a well-linked page; tests of the graph rules override them. */
type Graph = Pick<UrlFacts, "inbound" | "linkDepth" | "pagerank">;
const LINKED: Graph = { inbound: 2, linkDepth: 1, pagerank: 50 };

/** The site-rule projection of a page, as analyse.ts loads it. */
function facts(p: PageView, id: number, g: Partial<Graph> = {}): UrlFacts {
  return {
    ...LINKED,
    ...g,
    id,
    url: p.url,
    state: p.state,
    statusCode: p.statusCode,
    redirectTarget: null,
    discoveredVia: p.discoveredVia,
    page: p.html
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
        }
      : null,
  };
}
const NO_GRAPH: Graph = { inbound: 0, linkDepth: null, pagerank: null };
const redirect = (path: string, status: number, to: string, id: number): UrlFacts => ({ id, url: U(path), state: "redirected", statusCode: status, redirectTarget: U(to), discoveredVia: ["link"], page: null, ...NO_GRAPH });
const other = (path: string, state: UrlState, id: number, via: DiscoverySource[] = ["link"]): UrlFacts => ({ id, url: U(path), state, statusCode: null, redirectTarget: null, discoveredVia: via, page: null, ...NO_GRAPH });

function siteOf(...xs: (PageView | UrlFacts)[]): SiteView {
  const urls = xs.map((x, i) => ("html" in x ? facts(x, i + 1) : x));
  return { urls, byUrl: new Map(urls.map((u) => [u.url, u])) };
}

const ROBOTS_OK = "User-agent: *\nDisallow: /private/\nSitemap: https://a.test/sitemap.xml\n";
const sitemap = (over: Partial<SitemapDocRecord> = {}): SitemapDocRecord => ({
  url: U("/sitemap.xml"),
  via: "robots",
  parent: null,
  depth: 0,
  status: 200,
  kind: "urlset",
  urlCount: 3,
  errors: [],
  truncated: false,
  lastmod: { count: 3, distinct: 3, max: "2026-01-03", min: "2026-01-01", invalid: 0 },
  ...over,
});
const probe = (kind: ProbeRecord["kind"], url: string, over: Partial<ProbeRecord> = {}): ProbeRecord => ({ kind, url, started: true, status: 200, ...over });
const GOOD_PROBES: ProbeRecord[] = [
  probe("home_scheme", "http://a.test/", { status: 301, location: U("/") }),
  probe("home_www", "https://www.a.test/", { status: 301, location: U("/") }),
  probe("favicon", U("/favicon.ico"), { contentType: "image/x-icon" }),
  probe("llms_txt", U("/llms.txt"), { contentType: "text/plain", body: "# Fixture Site\n\n> Garden tools.\n" }),
  probe("og_image", U("/og.png"), { contentType: "image/png", width: 1200, height: 630 }),
];

interface CrawlOpts {
  robots?: Partial<RobotsRecord> | null;
  robotsBody?: string;
  sitemaps?: SitemapDocRecord[];
  probes?: ProbeRecord[];
  aiCrawlers?: "allow" | "block";
  keyPages?: string[];
  complete?: boolean;
  resources?: ResourceFacts[];
}
function crawlOf(o: CrawlOpts = {}): CrawlView {
  const robots: RobotsRecord | null =
    o.robots === null ? null : { url: U("/robots.txt"), started: true, status: 200, outcome: "parsed", body: o.robotsBody ?? ROBOTS_OK, sitemaps: [U("/sitemap.xml")], ...o.robots };
  return crawlView({
    id: "c1",
    site_origin: ORIGIN,
    status: "completed",
    config: { ...(o.aiCrawlers ? { aiCrawlers: o.aiCrawlers } : {}), ...(o.keyPages ? { keyPages: o.keyPages } : {}) },
    robots,
    sitemaps: o.sitemaps ?? [sitemap()],
    probes: o.probes ?? GOOD_PROBES,
    started_at: new Date("2026-06-01T00:00:00Z"),
    created_at: new Date("2026-06-01T00:00:00Z"),
  }, {
    complete: o.complete ?? true,
    resources: {
      links: new Map((o.resources ?? []).filter((r) => r.kind === "external_link").map((r) => [r.url, r])),
      images: new Map((o.resources ?? []).filter((r) => r.kind === "image").map((r) => [r.url, r])),
    },
  });
}

const rule = (id: string): Rule => {
  const r = RULES_BY_ID.get(id);
  if (!r) throw new Error(`no rule ${id}`);
  return r;
};
/**
 * Run one rule. A page rule sees `site` (default: a site of just that page); a site rule sees `pageIssues` (default:
 * none); a resource rule takes a ResourceFacts.
 */
function run(id: string, x: PageView | SiteView | ResourceFacts, crawl: CrawlView = crawlOf(), o: { site?: SiteView; pageIssues?: SiteCtx["pageIssues"] } = {}): Finding[] {
  const r = rule(id);
  if (r.scope === "page") {
    if (!("html" in x)) throw new Error(`${id} is a page rule`);
    return r.evaluate({ page: x, crawl, site: o.site ?? siteOf(x) });
  }
  if (r.scope === "resource") {
    if (!("kind" in x)) throw new Error(`${id} is a resource rule`);
    return r.evaluate({ resource: x, crawl });
  }
  if (!("urls" in x)) throw new Error(`${id} is a site rule`);
  return r.evaluate({ site: x, crawl, pageIssues: o.pageIssues ?? new Map() });
}

// The clean home and two clean content pages: distinct titles, descriptions and text.
const HOME_TEXT = `This site collects plain advice on hand tools for small gardens, allotments and balconies.
Each guide explains what a tool is for, which designs hold up after years of digging, and what is worth paying extra for.
We test every spade, fork, hoe and rake on clay, loam and sand across a full growing season before writing about it.
Prices change often, so the guides name features to look for rather than shops or brands.
Beginners should start with the guide to digging, then read about pruning once the first shrubs need shaping.
Experienced growers will find notes on restoring old tools: removing rust, replacing ash handles and regrinding a dull edge.
Nothing here is sponsored, and reader questions shape which tools we cover next spring.
If a guide helped you, tell a neighbour; if something is wrong, write to us and we will correct it within a week.
Seasonal checklists at the end of each guide remind you when to sharpen, oil and store each tool.
Children can help in the garden too, and a short guide covers small, safe tools sized for young hands.`;
const home = () =>
  pageFrom(
    "/",
    {
      title: "<title>Fixture Site: Garden Tools and Care</title>",
      description: '<meta name="description" content="Plain, independent advice on choosing, using and restoring hand tools for small gardens, allotments and balconies.">',
      h1: "<h1>Welcome to the garden tools site</h1>",
      body: `<main><p>${HOME_TEXT}</p></main>`,
    },
    { via: ["seed", "sitemap"] },
  );
const cleanSite = (...extra: (PageView | UrlFacts)[]) =>
  siteOf(
    home(),
    pageFrom("/a/", { title: "<title>Pruning Shears Compared | Fixture Site</title>", description: '<meta name="description" content="Bypass and anvil pruning shears compared: which cuts living stems cleanly and which suits dead wood in the autumn.">', h1: "<h1>Pruning shears</h1>", body: `<main><p>${TEXT.split("").reverse().join("")}</p></main>` }, { via: ["sitemap", "link"] }),
    ...extra,
  );

type Case = { pos: () => Finding[]; neg: () => Finding[] };
const PAGE = (id: string, pos: () => PageView, neg: () => PageView = () => pageFrom("/x/"), crawl?: () => CrawlView): Case => ({
  pos: () => run(id, pos(), crawl?.()),
  neg: () => run(id, neg(), crawl?.()),
});
const SITE = (id: string, pos: () => [SiteView, CrawlView?], neg: () => [SiteView, CrawlView?] = () => [cleanSite()]): Case => ({
  pos: () => run(id, ...(pos() as [SiteView, CrawlView?])),
  neg: () => run(id, ...(neg() as [SiteView, CrawlView?])),
});

/** A page rule judged against a site (its links' targets). */
const PS = (id: string, pos: () => [PageView, SiteView, CrawlView?], neg: () => [PageView, SiteView, CrawlView?]): Case => ({
  pos: () => {
    const [p, site, c] = pos();
    return run(id, p, c, { site });
  },
  neg: () => {
    const [p, site, c] = neg();
    return run(id, p, c, { site });
  },
});
/** A resource rule (external link or image, as the resource phase stored it). */
const RES = (id: string, pos: () => ResourceFacts, neg: () => ResourceFacts, crawl?: () => CrawlView): Case => ({
  pos: () => run(id, pos(), crawl?.()),
  neg: () => run(id, neg(), crawl?.()),
});
const res = (kind: ResourceFacts["kind"], url: string, over: Partial<ResourceFacts> = {}): ResourceFacts => ({
  kind,
  url,
  state: "done",
  skipCode: null,
  method: "HEAD",
  status: 200,
  contentType: kind === "image" ? "image/png" : "text/html",
  contentLength: 10_000,
  width: null,
  height: null,
  error: null,
  referrers: 1,
  samplePages: [U("/x/")],
  ...over,
});
/** A page body with main text plus extra markup. */
const withBody = (extra: string) => ({ body: `<main><p>${TEXT}</p>${extra}</main>` });
const IMGTAG = (attrs: string) => withBody(`<img ${attrs}>`);
const ld = (...blocks: unknown[]) => ({ head: blocks.map((b) => `<script type="application/ld+json">${typeof b === "string" ? b : JSON.stringify(b)}</script>`).join("") });
const crawlWithImage = (r: Partial<ResourceFacts>) => () => crawlOf({ resources: [res("image", U("/big.png"), r)] });
const tls = (daysLeft: number) => probe("tls_cert", U("/"), { status: null, cert: { subject: "a.test", issuer: "CA", validFrom: "2026-01-01T00:00:00.000Z", validTo: new Date(Date.parse("2026-06-01T00:00:00Z") + daysLeft * 86_400_000).toISOString(), altNames: ["a.test"], authorized: true, authorizationError: null } });
const exposed = (kind: "env_file" | "git_head", secret: ProbeRecord["secret"]) => probe(kind, U(kind === "env_file" ? "/.env" : "/.git/HEAD"), { contentType: "text/plain", secret });
/** pageIssues as analyse.ts tallies them: rule → template → pages. */
const issues = (ruleId: string, template: string, count: number) => new Map([[ruleId, new Map([[template, { count, sample: [U("/p/1/")] }]])]]);
const templated = (n: number, template: string) => Array.from({ length: n }, (_, i) => ({ ...facts(pageFrom(`/p/${i}/`), 100 + i), page: { ...facts(pageFrom(`/p/${i}/`), 100 + i).page!, template } }));
const SITE_ISSUES = (id: string, pos: () => [SiteView, SiteCtx["pageIssues"]], neg: () => [SiteView, SiteCtx["pageIssues"]]): Case => ({
  pos: () => {
    const [site, pageIssues] = pos();
    return run(id, site, crawlOf(), { pageIssues });
  },
  neg: () => {
    const [site, pageIssues] = neg();
    return run(id, site, crawlOf(), { pageIssues });
  },
});

const textOf = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const BOILER = `<nav>${Array.from({ length: 60 }, (_, i) => `<a href="/n${i}/">Navigation link number ${i}</a>`).join(" ")}</nav>`;

const CASES: Record<string, Case> = {
  // ---------- IDX ----------
  "IDX-001": PAGE("IDX-001", () => bare("/gone", 404), () => pageFrom("/x/")),
  "IDX-002": PAGE("IDX-002", () => bare("/err", 503), () => bare("/gone", 404)),
  "IDX-003": SITE("IDX-003", () => [cleanSite(redirect("/r1", 301, "/r2", 10), redirect("/r2", 301, "/r3", 11), redirect("/r3", 301, "/", 12))], () => [cleanSite(redirect("/r1", 301, "/r2", 10), redirect("/r2", 301, "/", 11))]),
  "IDX-004": SITE("IDX-004", () => [cleanSite(redirect("/l1", 301, "/l2", 10), redirect("/l2", 301, "/l1", 11))], () => [cleanSite(redirect("/l1", 301, "/", 10))]),
  "IDX-005": SITE("IDX-005", () => [cleanSite(redirect("/t", 302, "/", 10))], () => [cleanSite(redirect("/t", 301, "/", 10))]),
  "IDX-006": PAGE("IDX-006", () => pageFrom("/x/", { head: '<meta http-equiv="refresh" content="0; url=/y/">' })),
  "IDX-007": SITE("IDX-007", () => [cleanSite(other("/private/p", "blocked_robots", 10, ["sitemap"]))], () => [cleanSite(other("/private/p", "blocked_robots", 10, ["link"]))]),
  "IDX-008": PAGE("IDX-008", () => pageFrom("/x/", { head: '<meta name="robots" content="noindex">' }, { via: ["sitemap"] }), () => pageFrom("/x/", { head: '<meta name="robots" content="noindex">' }, { via: ["link"] })),
  "IDX-009": PAGE("IDX-009", () => pageFrom("/x/", {}, { headers: { "x-robots-tag": "noindex" } }), () => pageFrom("/x/", {}, { headers: { "x-robots-tag": "googlebot: noarchive" } })),
  "IDX-010": PAGE("IDX-010", () => pageFrom("/x/", { head: '<meta name="robots" content="noindex">' }, { headers: { "x-robots-tag": "index, follow" } }), () => pageFrom("/x/", { head: '<meta name="robots" content="noindex">' }, { headers: { "x-robots-tag": "noindex" } })),
  "IDX-011": PAGE("IDX-011", () => pageFrom("/x/", { canonical: "" })),
  "IDX-012": SITE("IDX-012", () => [cleanSite(pageFrom("/c/", { canonical: `<link rel="canonical" href="${U("/gone")}">` }), bare("/gone", 404))], () => [cleanSite(pageFrom("/c/", { canonical: `<link rel="canonical" href="${U("/")}">` }))]),
  "IDX-013": SITE("IDX-013", () => [cleanSite(pageFrom("/c1/", { canonical: `<link rel="canonical" href="${U("/c2/")}">` }), pageFrom("/c2/", { canonical: `<link rel="canonical" href="${U("/")}">` }))], () => [cleanSite(pageFrom("/c1/", { canonical: `<link rel="canonical" href="${U("/")}">` }))]),
  "IDX-014": SITE("IDX-014", () => [cleanSite(pageFrom("/c/", { canonical: `<link rel="canonical" href="${U("/ni/")}">` }), pageFrom("/ni/", { head: '<meta name="robots" content="noindex">' }))], () => [cleanSite(pageFrom("/c/", { canonical: `<link rel="canonical" href="${U("/")}">` }))]),
  "IDX-015": PAGE("IDX-015", () => pageFrom("/x/", { head: `<link rel="canonical" href="${U("/y/")}">` })),
  "IDX-016": PAGE("IDX-016", () => pageFrom("/x/", { body: `<main><p>${TEXT}</p><link rel="canonical" href="${U("/x/")}"></main>` })),
  "IDX-017": PAGE("IDX-017", () => pageFrom("/x/", { canonical: '<link rel="canonical" href="/x/">' })),
  "IDX-019": PAGE("IDX-019", () => pageFrom("/x/", { h1: "<h1>Page not found</h1>" })),
  "IDX-020": SITE("IDX-020", () => [cleanSite(), crawlOf({ probes: [probe("home_scheme", "http://a.test/")] })]),
  "IDX-021": SITE("IDX-021", () => [cleanSite(), crawlOf({ probes: [probe("home_www", "https://www.a.test/")] })]),
  "IDX-022": SITE("IDX-022", () => [cleanSite(pageFrom("/s/"), pageFrom("/s"))], () => [cleanSite(pageFrom("/s/"), redirect("/s", 301, "/s/", 10))]),
  "IDX-023": SITE("IDX-023", () => [cleanSite(pageFrom("/case/"), pageFrom("/CASE/"))], () => [cleanSite(pageFrom("/case/"), bare("/CASE/", 404))]),
  "IDX-024": PAGE("IDX-024", () => pageFrom("/x/?sort=price", { canonical: "" }), () => pageFrom("/x/?sort=price", { canonical: `<link rel="canonical" href="${U("/x/")}">` })),
  "IDX-025": SITE("IDX-025", () => [cleanSite(), crawlOf({ robots: { status: 503, outcome: "disallow_all", body: undefined } })], () => [cleanSite(), crawlOf({ robots: { status: 404, outcome: "allow_all", body: undefined, sitemaps: [] } })]),
  "IDX-026": PAGE("IDX-026", () => pageFrom("/x/", { head: `<link rel="stylesheet" href="/private/site.css">` }), () => pageFrom("/x/", { head: `<link rel="stylesheet" href="/assets/site.css">` })),
  "IDX-027": SITE("IDX-027", () => [cleanSite(), crawlOf({ robotsBody: "User-agent: *\nDisallow:\n", robots: { sitemaps: [] } })]),
  "IDX-028": SITE("IDX-028", () => [cleanSite({ ...redirect("/old", 301, "/", 10), discoveredVia: ["sitemap"] })], () => [cleanSite(redirect("/old", 301, "/", 10))]),
  "IDX-029": SITE("IDX-029", () => [cleanSite(pageFrom("/ni/", { head: '<meta name="robots" content="noindex">' }, { via: ["sitemap"] }))], () => [cleanSite(pageFrom("/ni/", { head: '<meta name="robots" content="noindex">' }, { via: ["link"] }))]),
  "IDX-030": SITE("IDX-030", () => [cleanSite(), crawlOf({ sitemaps: [sitemap({ truncated: true, urlCount: 50_000 })] })]),
  "IDX-031": SITE("IDX-031", () => [cleanSite(), crawlOf({ sitemaps: [sitemap({ lastmod: { count: 3, distinct: 1, max: "2026-01-01", min: "2026-01-01", invalid: 0 } })] })]),
  "IDX-032": SITE("IDX-032", () => [cleanSite(pageFrom("/nosm/", {}, { via: ["link"] }))], () => [cleanSite(pageFrom("/nosm/", {}, { via: ["link"] })), crawlOf({ sitemaps: [] })]),

  // ---------- META ----------
  "META-001": PAGE("META-001", () => pageFrom("/x/", { title: "" })),
  "META-002": PAGE("META-002", () => pageFrom("/x/", { title: "<title> </title>" })),
  "META-003": PAGE("META-003", () => pageFrom("/x/", { head: "<title>Second title for this page</title>" }), () => pageFrom("/x/", { body: `<main><p>${TEXT}</p><svg><title>Icon</title></svg></main>` })),
  "META-004": SITE("META-004", () => [cleanSite(pageFrom("/d1/"), pageFrom("/d2/"))], () => [cleanSite(pageFrom("/d1/"), pageFrom("/d2/", { head: '<meta name="robots" content="noindex">' }))]),
  "META-005": PAGE("META-005", () => pageFrom("/x/", { title: "<title>A very long title that keeps going on about garden tools, spades, forks and shears | Fixture Site</title>" })),
  "META-006": PAGE("META-006", () => pageFrom("/x/", { title: "<title>Tools</title>" })),
  "META-007": SITE(
    "META-007",
    () => [siteOf(...["/t1/", "/t2/", "/t3/"].map((p, i) => pageFrom(p, { title: `<title>Tool number ${i}</title>`, h1: `<h1>Tool Number ${i}</h1>` })))],
    () => [siteOf(...["/t1/", "/t2/", "/t3/"].map((p, i) => pageFrom(p, { title: `<title>Tool number ${i}</title>`, h1: i ? `<h1>Tool Number ${i}</h1>` : "<h1>Something else</h1>" })))],
  ),
  "META-008": PAGE("META-008", () => pageFrom("/x/", { description: '<meta name="description" content="">' })),
  "META-009": SITE("META-009", () => [cleanSite(pageFrom("/d1/", { title: "<title>First distinct garden page</title>" }), pageFrom("/d2/", { title: "<title>Second distinct garden page</title>" }))], () => [cleanSite(pageFrom("/d1/", { title: "<title>First distinct garden page</title>" }))]),
  "META-010": PAGE("META-010", () => pageFrom("/x/", { description: '<meta name="description" content="Garden tools.">' })),
  "META-011": PAGE("META-011", () => pageFrom("/x/", { lang: "" })),
  "META-012": PAGE("META-012", () => pageFrom("/x/", { lang: ' lang="fr"' }), () => pageFrom("/x/", { lang: ' lang="en-GB"' })),
  "META-013": PAGE("META-013", () => pageFrom("/x/", { viewport: "" })),
  "META-014": PAGE("META-014", () => pageFrom("/x/", { viewport: '<meta name="viewport" content="width=device-width, user-scalable=no">' }), () => pageFrom("/x/", { viewport: '<meta name="viewport" content="width=device-width, maximum-scale=5">' })),
  "META-015": PAGE("META-015", () => pageFrom("/x/", { charset: "" }, { headers: { "content-type": "text/html" } }), () => pageFrom("/x/", { charset: "" }, { headers: { "content-type": "text/html; charset=utf-8" } })),
  "META-016": PAGE("META-016", () => pageFrom("/x/", { social: '<meta name="twitter:card" content="summary">' })),
  "META-017": SITE("META-017", () => [cleanSite(), crawlOf({ probes: [probe("og_image", U("/og.png"), { width: 100, height: 100 })] })], () => [cleanSite(), crawlOf({ probes: [probe("og_image", U("/og.png"), { skipped: "cap" , status: null })] })]),
  "META-018": PAGE("META-018", () => pageFrom("/x/", { social: `<meta property="og:title" content="t"><meta property="og:image" content="${U("/og.png")}"><meta property="og:url" content="${U("/x/")}">` })),
  "META-019": SITE("META-019", () => [cleanSite(), crawlOf({ probes: [probe("favicon", U("/favicon.ico"), { status: 404 })] })]),

  // ---------- CNT ----------
  "CNT-001": PAGE("CNT-001", () => pageFrom("/x/", { h1: "" })),
  "CNT-002": PAGE("CNT-002", () => pageFrom("/x/", { h1: "<h1>Garden tools</h1><h1>More garden tools</h1>" })),
  "CNT-003": PAGE("CNT-003", () => pageFrom("/x/", { body: `<main><h2></h2><p>${TEXT}</p></main>` })),
  "CNT-004": PAGE("CNT-004", () => pageFrom("/x/", { body: `<main><h3>Care</h3><p>${TEXT}</p></main>` }), () => pageFrom("/x/", { body: `<main><h2>Care</h2><h3>Oil</h3><h2>Store</h2><p>${TEXT}</p></main>` })),
  "CNT-005": PAGE("CNT-005", () => pageFrom("/x/", { body: "<main><p>Only a few words here about spades.</p></main>" }), () => pageFrom("/x/", { head: '<meta name="robots" content="noindex">', body: "<main><p>Only a few words here about spades.</p></main>" })),
  "CNT-006": SITE("CNT-006", () => [cleanSite(pageFrom("/d1/", { title: "<title>Duplicate one garden page</title>" }), pageFrom("/d2/", { title: "<title>Duplicate two garden page</title>" }))], () => [cleanSite(pageFrom("/d1/", { title: "<title>Duplicate one garden page</title>" }))]),
  "CNT-007": SITE(
    "CNT-007",
    () => [cleanSite(pageFrom("/n1/", { title: "<title>Near one garden page</title>" }), pageFrom("/n2/", { title: "<title>Near two garden page</title>", body: `<main><p>${TEXT.replace("decades", "years")}</p><h2>Care</h2><p>Oil the handles.</p></main>` }))],
    () => [cleanSite(pageFrom("/n1/", { title: "<title>Near one garden page</title>" }))],
  ),
  "CNT-008": PAGE("CNT-008", () => pageFrom("/x/", { body: `${BOILER}<main><p>Short main text about spades and forks.</p></main>` })),
  "CNT-009": PAGE("CNT-009", () => pageFrom("/x/", { h1: "<h1>Weather forecast tomorrow</h1>" })),
  "CNT-010": PAGE("CNT-010", () => pageFrom("/x/", { body: `<main><p>Lorem ipsum dolor sit amet. ${TEXT}</p></main>` })),
  "CNT-011": PAGE("CNT-011", () => pageFrom("/x/", { body: `<main><p>Error 404: the page you asked for is not here. ${TEXT}</p></main>` })),
  "CNT-012": PAGE("CNT-012", () => pageFrom("/x/", { head: `<script>${"var x = 1;".repeat(3000)}</script>` })),

  // ---------- AIS ----------
  "AIS-001": SITE("AIS-001", () => [cleanSite()], () => [cleanSite(), crawlOf({ robots: { status: 503, outcome: "disallow_all", body: undefined } })]),
  "AIS-002": SITE("AIS-002", () => [cleanSite(), crawlOf({ aiCrawlers: "allow", robotsBody: ROBOTS_OK + "\nUser-agent: GPTBot\nDisallow: /\n" })], () => [cleanSite(), crawlOf({ aiCrawlers: "block", robotsBody: ROBOTS_OK + "\nUser-agent: GPTBot\nDisallow: /\n" })]),
  "AIS-003": SITE("AIS-003", () => [cleanSite(), crawlOf({ probes: [probe("llms_txt", U("/llms.txt"), { status: 404 })] })]),

  // ---------- LNK ----------
  "LNK-001": PS(
    "LNK-001",
    () => [pageFrom("/x/", withBody('<a href="/gone">Old guide to spades</a>')), cleanSite(bare("/gone", 404))],
    () => [pageFrom("/x/", withBody('<a href="/a/">Pruning shears guide</a>')), cleanSite()],
  ),
  "LNK-002": PS(
    "LNK-002",
    () => [pageFrom("/x/", withBody('<a href="/r">Pruning shears guide</a>')), cleanSite(redirect("/r", 301, "/a/", 10))],
    () => [pageFrom("/x/", withBody('<a href="/a/">Pruning shears guide</a>')), cleanSite(redirect("/r", 301, "/a/", 10))],
  ),
  "LNK-003": SITE("LNK-003", () => [cleanSite(facts(pageFrom("/o/", {}, { via: ["sitemap"] }), 10, { inbound: 0 }))], () => [cleanSite(facts(pageFrom("/o/", {}, { via: ["sitemap"] }), 10, { inbound: 2 }))]),
  "LNK-004": SITE("LNK-004", () => [cleanSite(facts(pageFrom("/d/"), 10, { linkDepth: 5 }))], () => [cleanSite(facts(pageFrom("/d/"), 10, { linkDepth: 4 }))]),
  "LNK-005": SITE("LNK-005", () => [cleanSite(facts(pageFrom("/w/"), 10, { inbound: 1 }))], () => [cleanSite(facts(pageFrom("/w/"), 10, { inbound: 2 }))]),
  "LNK-006": PAGE("LNK-006", () => pageFrom("/x/", withBody('<a href="/a/" rel="nofollow">Pruning shears guide</a>')), () => pageFrom("/x/", withBody('<a href="https://other.test/" rel="nofollow">A partner site</a><a href="/a/">Pruning shears guide</a>'))),
  "LNK-007": PAGE("LNK-007", () => pageFrom("/x/", withBody('<a href="/a/">Click here</a>')), () => pageFrom("/x/", withBody('<a href="/a/">Pruning shears compared</a>'))),
  "LNK-008": PAGE("LNK-008", () => pageFrom("/x/", withBody(Array.from({ length: 301 }, (_, i) => `<a href="/l${i}/">Tool guide ${i}</a>`).join(""))), () => pageFrom("/x/", withBody(Array.from({ length: 300 }, (_, i) => `<a href="/l${i}/">Tool guide ${i}</a>`).join("")))),
  "LNK-010": RES("LNK-010", () => res("external_link", "https://gone.test/page", { status: 404 }), () => res("external_link", "https://ok.test/page", { status: 200 })),
  "LNK-011": PAGE("LNK-011", () => pageFrom("/x/", withBody('<a href="http://a.test/a/">Pruning shears guide</a>')), () => pageFrom("/x/", withBody('<a href="https://a.test/a/">Pruning shears guide</a>'))),
  "LNK-012": SITE(
    "LNK-012",
    () => [cleanSite(facts(pageFrom("/k/"), 10, { pagerank: 10 })), crawlOf({ keyPages: [U("/k/")] })],
    () => [cleanSite(facts(pageFrom("/k/"), 10, { pagerank: 60 })), crawlOf({ keyPages: [U("/k/")] })],
  ),
  "LNK-013": PAGE("LNK-013", () => pageFrom("/x/", { head: '<link rel="next" href="/x/2/">' }), () => pageFrom("/x/", { head: '<link rel="next" href="/x/2/">', ...withBody('<a href="/x/2/">Next page of guides</a>') })),
  "LNK-014": SITE("LNK-014", () => [cleanSite(...Array.from({ length: 101 }, (_, i) => other(`/f?c=${i}`, "fetched", 10 + i)))], () => [cleanSite(...Array.from({ length: 100 }, (_, i) => other(`/f?c=${i}`, "fetched", 10 + i)))]),

  // ---------- I18N ----------
  "I18N-001": SITE(
    "I18N-001",
    () => [cleanSite(pageFrom("/en/", { head: '<link rel="alternate" hreflang="en" href="/en/"><link rel="alternate" hreflang="de" href="/de/">' }), bare("/de/", 404))],
    () => [cleanSite(pageFrom("/en/", { head: '<link rel="alternate" hreflang="en" href="/en/"><link rel="alternate" hreflang="de" href="/de/">' }), pageFrom("/de/", { head: '<link rel="alternate" hreflang="en" href="/en/"><link rel="alternate" hreflang="de" href="/de/">' }))],
  ),
  "I18N-002": SITE(
    "I18N-002",
    () => [cleanSite(pageFrom("/en/", { head: '<link rel="alternate" hreflang="en" href="/en/"><link rel="alternate" hreflang="de" href="/de/">' }), pageFrom("/de/", { head: '<link rel="alternate" hreflang="de" href="/de/">' }))],
    () => [cleanSite(pageFrom("/en/", { head: '<link rel="alternate" hreflang="en" href="/en/"><link rel="alternate" hreflang="de" href="/de/">' }), pageFrom("/de/", { head: '<link rel="alternate" hreflang="en" href="/en/"><link rel="alternate" hreflang="de" href="/de/">' }))],
  ),
  "I18N-003": PAGE("I18N-003", () => pageFrom("/x/", { head: '<link rel="alternate" hreflang="en-UK" href="/x/">' }), () => pageFrom("/x/", { head: '<link rel="alternate" hreflang="en-GB" href="/x/">' })),
  "I18N-004": PAGE("I18N-004", () => pageFrom("/x/", { head: '<link rel="alternate" hreflang="de" href="/de/">' }), () => pageFrom("/x/", { head: '<link rel="alternate" hreflang="en" href="/x/"><link rel="alternate" hreflang="de" href="/de/">' })),
  "I18N-005": PAGE("I18N-005", () => pageFrom("/x/", { head: '<link rel="alternate" hreflang="en" href="/x/">' }), () => pageFrom("/x/", { head: '<link rel="alternate" hreflang="en" href="/x/"><link rel="alternate" hreflang="x-default" href="/x/">' })),
  "I18N-006": SITE(
    "I18N-006",
    () => [cleanSite(pageFrom("/en/", { head: '<link rel="alternate" hreflang="en" href="/en/"><link rel="alternate" hreflang="de" href="/de/">' }), pageFrom("/de/", { canonical: `<link rel="canonical" href="${U("/en/")}">` }))],
    () => [cleanSite(pageFrom("/en/", { head: '<link rel="alternate" hreflang="en" href="/en/"><link rel="alternate" hreflang="de" href="/de/">' }), pageFrom("/de/"))],
  ),

  // ---------- IMG ----------
  "IMG-001": PAGE("IMG-001", () => pageFrom("/x/", IMGTAG('src="/a.png" width="10" height="10"')), () => pageFrom("/x/", IMGTAG('src="/a.png" alt="A spade" width="10" height="10"'))),
  "IMG-002": PAGE("IMG-002", () => pageFrom("/x/", withBody('<a href="/a/"><img src="/a.png" alt="" width="10" height="10"></a>')), () => pageFrom("/x/", { body: `<main><p>${TEXT}</p></main><footer><img src="/dot.png" alt="" width="10" height="10"></footer>` })),
  "IMG-003": PAGE("IMG-003", () => pageFrom("/x/", IMGTAG('src="/img/IMG_2041.jpg" alt="IMG_2041.jpg" width="10" height="10"')), () => pageFrom("/x/", IMGTAG('src="/img/IMG_2041.jpg" alt="A worn spade" width="10" height="10"'))),
  "IMG-004": RES("IMG-004", () => res("image", U("/missing.png"), { status: 404 }), () => res("image", U("/ok.png"))),
  "IMG-005": RES("IMG-005", () => res("image", U("/big.png"), { contentLength: 300 * 1024 }), () => res("image", U("/small.png"), { contentLength: 200 * 1024 })),
  "IMG-006": RES("IMG-006", () => res("image", U("/photo.jpg"), { contentType: "image/jpeg", contentLength: 150 * 1024 }), () => res("image", U("/photo.webp"), { contentType: "image/webp", contentLength: 150 * 1024 })),
  "IMG-007": PAGE("IMG-007", () => pageFrom("/x/", IMGTAG('src="/a.png" alt="A spade"')), () => pageFrom("/x/", IMGTAG('src="/a.png" alt="A spade" width="10" height="10"'))),
  "IMG-008": PAGE("IMG-008", () => pageFrom("/x/", IMGTAG('src="/big.png" alt="A spade" width="300" height="200"')), () => pageFrom("/x/", IMGTAG('src="/big.png" alt="A spade" width="600" height="400"')), crawlWithImage({ width: 1200, height: 800 })),
  "IMG-010": PAGE("IMG-010", () => pageFrom("/x/", IMGTAG('src="/big.png" alt="A spade" width="600" height="400"')), () => pageFrom("/x/", IMGTAG('src="/big.png" srcset="/big.png 1200w, /small.png 600w" alt="A spade" width="600" height="400"')), crawlWithImage({ width: 1200, height: 800 })),
  "IMG-011": PAGE("IMG-011", () => pageFrom("/x/", withBody('<video src="/v.mp4"></video>')), () => pageFrom("/x/", withBody('<video src="/v.mp4" poster="/v.jpg"></video>'))),

  // ---------- SD ----------
  "SD-001": PAGE("SD-001", () => pageFrom("/x/", ld("{\"@type\": \"Thing\",}")), () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Thing", name: "Spade" }))),
  "SD-002": PAGE("SD-002", () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Thing", nmae: "Spade" })), () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Thing", name: "Spade" }))),
  "SD-003": PAGE("SD-003", () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Event", name: "Show", location: { "@type": "Place", address: "1 Road" } })), () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Event", name: "Show", startDate: "2026-07-01", location: { "@type": "Place", address: "1 Road" } }))),
  "SD-004": PAGE("SD-004", () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, item: U("/") }] }, { "@context": "https://schema.org", "@type": "Article", headline: "Spades" })), () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, item: U("/") }] }))),
  "SD-005": PAGE("SD-005", () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Organization", name: "Fixture Site" }, { "@context": "https://schema.org", "@type": "Organization", name: "Fixture Ltd" })), () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Organization", name: "Fixture Site" }, { "@context": "https://schema.org", "@type": "Organization", name: "Fixture Site", url: U("/") }))),
  "SD-006": PAGE("SD-006", () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Product", name: "Spade", aggregateRating: { "@type": "AggregateRating", ratingValue: "4.8", reviewCount: "212" } })), () => pageFrom("/x/", { ...ld({ "@context": "https://schema.org", "@type": "Product", name: "Spade", aggregateRating: { "@type": "AggregateRating", ratingValue: "4.8", reviewCount: "212" } }), ...withBody("<p>Rated 4.8 out of 5 from 212 reviews.</p>") })),
  "SD-007": PAGE("SD-007", () => home(), () => pageFrom("/", { ...ld({ "@context": "https://schema.org", "@type": "Organization", name: "Fixture Site", url: U("/") }) })),
  "SD-008": PAGE("SD-008", () => pageFrom("/guides/tools/spades/"), () => pageFrom("/guides/tools/spades/", ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "Guides", item: U("/guides/") }] }))),
  "SD-009": PAGE("SD-009", () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Product", name: "Spade", review: { "@type": "Review", author: "A", reviewRating: { "@type": "Rating", ratingValue: 5 } } })), () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Product", name: "Spade", offers: { "@type": "Offer", price: "25.00", priceCurrency: "GBP" } }))),
  "SD-010": PAGE("SD-010", () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "HowTo", name: "Sharpen a spade" })), () => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Article", headline: "Sharpen a spade" }))),

  // ---------- SEC ----------
  "SEC-001": PAGE("SEC-001", () => ({ ...pageFrom("/x/"), finalUrl: "http://a.test/x/" }), () => pageFrom("/x/")),
  "SEC-002": PAGE("SEC-002", () => pageFrom("/x/", { head: '<script src="http://cdn.test/a.js"></script>' }), () => pageFrom("/x/", { head: '<script src="https://cdn.test/a.js"></script>', ...withBody('<a href="http://other.test/">An http link is not loaded</a>') })),
  "SEC-003": SITE("SEC-003", () => [cleanSite(), crawlOf({ probes: [...GOOD_PROBES, tls(20)] })], () => [cleanSite(), crawlOf({ probes: [...GOOD_PROBES, tls(22)] })]),
  "SEC-004": PAGE("SEC-004", () => pageFrom("/", {}, { headers: { "strict-transport-security": "max-age=0" } }), () => pageFrom("/", {}, { headers: { "strict-transport-security": "max-age=31536000" } })),
  "SEC-005": PAGE("SEC-005", () => pageFrom("/", {}, { headers: { "x-content-type-options": "nosniff", "x-frame-options": "DENY" } }), () => pageFrom("/", {}, { headers: { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'self'; frame-ancestors 'none'" } })),
  "SEC-006": SITE("SEC-006", () => [cleanSite(), crawlOf({ probes: [...GOOD_PROBES, exposed("env_file", { pattern: "env_key_value", lines: 3 })] })], () => [cleanSite(), crawlOf({ probes: [...GOOD_PROBES, exposed("env_file", null), exposed("git_head", null)] })]),

  // ---------- SITE ----------
  "SITE-001": SITE_ISSUES("SITE-001", () => [cleanSite(...templated(10, "T1")), issues("IMG-007", "T1", 9)], () => [cleanSite(...templated(10, "T1")), issues("IMG-007", "T1", 8)]),
  "SITE-002": SITE("SITE-002", () => [cleanSite(facts(pageFrom("/unlisted/"), 10))], () => [cleanSite(facts(pageFrom("/listed/", {}, { via: ["sitemap", "link"] }), 10))]),
  "SITE-003": SITE("SITE-003", () => [cleanSite(bare("/e1", 404), bare("/e2", 404), bare("/e3", 404))], () => [cleanSite(bare("/e1", 404))]),
};

describe("rule catalog", () => {
  it("every registered rule has a test case, and every case names a registered rule", () => {
    expect(Object.keys(CASES).sort()).toEqual(RULES.map((r) => r.id).sort());
    expect(RULES.length).toBe(31 + 19 + 12 + 3 + 13 + 6 + 10 + 10 + 6 + 3);
    expect(Object.keys(DEFERRED_RULES)).toEqual(["IDX-018", "CNT-013", "CNT-014", "AIS-004", "LNK-009", "IMG-009", "SITE-004", "SITE-005", "PERF-*", "A11Y-*"]);
    // A deferred rule is never also registered.
    for (const id of Object.keys(DEFERRED_RULES)) expect(RULES_BY_ID.has(id), id).toBe(false);
  });

  it("ids are unique and every rule has a complete explanation", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const r of RULES) {
      expect(r.explain.why && r.explain.fix && r.explain.acceptance, r.id).toBeTruthy();
      expect(r.version).toBeGreaterThanOrEqual(1);
    }
  });

  it("legacy map points only at catalog-shaped IDs", () => {
    for (const v of Object.values(LEGACY_TO_CATALOG)) if (v !== null) expect(v).toMatch(/^[A-Z0-9]+-\d{3}$/);
  });
});

describe("clean baseline", () => {
  it("no page rule fires on a clean page", () => {
    const page = pageFrom("/clean/", {}, { via: ["sitemap", "link"] });
    const crawl = crawlOf({ aiCrawlers: "allow" });
    const found = RULES.filter((r) => r.scope === "page").flatMap((r) => (r.scope === "page" ? r.evaluate({ page, crawl, site: cleanSite() }) : []));
    expect(found).toEqual([]);
  });

  it("no site rule fires on a clean site (AIS-001 reports robots.txt, not a page)", () => {
    const site = cleanSite();
    const crawl = crawlOf({ aiCrawlers: "allow", keyPages: [U("/")] });
    const found = RULES.filter((r) => r.scope === "site").flatMap((r) => (r.scope === "site" ? r.evaluate({ site, crawl, pageIssues: new Map() }) : []));
    expect(found.map((f) => f.ruleId)).toEqual(["AIS-001"]);
    expect(found[0].url).toBe(U("/robots.txt"));
  });
});

describe.each(Object.keys(CASES))("%s", (id) => {
  it("fires on its positive case", () => {
    const f = CASES[id].pos();
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) expect(x).toMatchObject({ ruleId: id, ruleVersion: rule(id).version, confidence: rule(id).confidence, outcome: "issue" });
  });
  it("is silent on its negative case", () => {
    expect(CASES[id].neg()).toEqual([]);
  });
});

describe("probes skipped by robots.txt make their rules inconclusive, not silent", () => {
  const skipped = (kind: ProbeRecord["kind"], url: string) => probe(kind, url, { started: false, status: null, skipped: "blocked by robots.txt: Disallow: / applies to SiteSentryBot", skipCode: "probe_skipped_robots" });
  it.each([
    ["IDX-020", skipped("home_scheme", "http://a.test/"), U("/")],
    ["IDX-021", skipped("home_www", "https://www.a.test/"), U("/")],
    ["META-017", skipped("og_image", U("/og.png")), null],
    ["META-019", skipped("favicon", U("/favicon.ico")), U("/")],
    ["AIS-003", skipped("llms_txt", U("/llms.txt")), U("/llms.txt")],
  ] as const)("%s", (id, p, url) => {
    const probes = [...GOOD_PROBES.filter((g) => g.kind !== p.kind), p];
    const f = run(id, cleanSite(), crawlOf({ probes }));
    expect(f.length).toBeGreaterThan(0);
    for (const x of f) expect(x).toMatchObject({ ruleId: id, outcome: "inconclusive", evidence: { code: "probe_skipped_robots" } });
    if (url) expect(f.map((x) => x.url)).toEqual([url]);
  });
  it("a probe skipped for another reason (over the og:image cap) stays silent", () => {
    expect(run("META-017", cleanSite(), crawlOf({ probes: [probe("og_image", U("/og.png"), { started: false, status: null, skipped: "cap", skipCode: "over_cap" })] }))).toEqual([]);
  });
});

describe("Phase 2b details", () => {
  it("graph rules report inconclusive, not issue, when the crawl did not reach every URL", () => {
    const site = cleanSite(facts(pageFrom("/o/", {}, { via: ["sitemap"] }), 10, { inbound: 0 }), facts(pageFrom("/w/"), 11, { inbound: 1 }));
    for (const id of ["LNK-003", "LNK-005"]) {
      expect(run(id, site, crawlOf({ complete: false })).map((f) => [f.outcome, f.evidence.code]), id).toEqual([["inconclusive", "partial_crawl"]]);
    }
  });

  it("LNK-012 needs the keyPages setting", () => {
    expect(() => run("LNK-012", cleanSite())).toThrow(NeedsConfig);
  });

  it("LNK-010 and IMG-004: 403, 429, 5xx and transport errors are ambiguous; DNS failure is broken", () => {
    for (const status of [403, 429, 503]) expect(run("LNK-010", res("external_link", "https://x.test/", { status }))[0].outcome, String(status)).toBe("inconclusive");
    expect(run("LNK-010", res("external_link", "https://x.test/", { status: null, error: { code: "TIMEOUT", message: "No response within 30s." } }))[0].outcome).toBe("inconclusive");
    expect(run("LNK-010", res("external_link", "https://x.test/", { status: null, error: { code: "DNS_FAILED", message: "no such host" } }))[0].outcome).toBe("issue");
    expect(run("LNK-010", res("external_link", "https://x.test/", { state: "skipped", skipCode: "blocked_robots", status: null }))).toEqual([]);
    expect(run("IMG-004", res("image", U("/a.png"), { status: 503 }))[0].outcome).toBe("inconclusive");
    expect(run("IMG-004", res("image", U("/a.png"), { status: 403 }))[0].outcome).toBe("issue");
  });

  it("IMG-005 is inconclusive without Content-Length; IMG-008 and IMG-010 ignore images the resource phase did not check", () => {
    expect(run("IMG-005", res("image", U("/a.png"), { contentLength: null }))[0]).toMatchObject({ outcome: "inconclusive", evidence: { code: "size_unknown" } });
    expect(run("IMG-008", pageFrom("/x/", IMGTAG('src="/big.png" alt="A spade" width="300" height="200"')))).toEqual([]);
    expect(run("IMG-008", pageFrom("/x/", IMGTAG('src="/big.png" alt="A spade" width="300" height="200"')), crawlWithImage({ status: 404, width: 1200 })())).toEqual([]);
  });

  it("IMG-002 needs a reason to call an empty-alt image content (pre-2b snapshots have none)", () => {
    const p = pageFrom("/x/", withBody('<a href="/a/"><img src="/a.png" alt="" width="10" height="10"></a>'));
    expect(run("IMG-002", { ...p, images: p.images.map(({ linked, inMain, inPicture, ...i }) => (void linked, void inMain, void inPicture, i)) })).toEqual([]);
    expect(run("IMG-002", pageFrom("/x/", { body: `<main><p>${TEXT}</p></main><footer><img src="/big.png" alt="" width="10" height="10"></footer>` }), crawlWithImage({ width: 800, height: 600 })())[0].evidence).toMatchObject({ images: [{ why: ["large"] }] });
  });

  it("SD-003 checks nested Offer and Review, which need no itemReviewed inside the item they review", () => {
    const product = (extra: Record<string, unknown>) => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Product", name: "Spade", ...extra }));
    expect(run("SD-003", product({ offers: { "@type": "Offer", priceCurrency: "GBP" } }))[0].evidence.gaps).toEqual([expect.objectContaining({ type: "Offer", at: "offers of block 1", missing: ["price or priceSpecification"] })]);
    expect(run("SD-003", product({ review: { "@type": "Review", author: "A", reviewRating: { "@type": "Rating", ratingValue: 5 } } }))).toEqual([]);
    expect(run("SD-003", product({ review: { "@type": "Review", author: "A" } }))[0].evidence.gaps).toEqual([expect.objectContaining({ type: "Review", missing: ["reviewRating"] })]);
    // Google's Offer and ListItem lists apply only where the feature puts them: a Product's offers, a BreadcrumbList.
    // An Offer in a service's OfferCatalog and a ListItem of a plain ItemList are not judged (example-client.ae validation).
    const service = pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Service", name: "SEO", hasOfferCatalog: { "@type": "OfferCatalog", itemListElement: [{ "@type": "Offer", itemOffered: { "@type": "Service", name: "Audit" } }] } }));
    expect(run("SD-003", service)).toEqual([]);
    expect(run("SD-004", service)).toEqual([]);
    expect(run("SD-003", pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "ItemList", itemListElement: [{ "@type": "ListItem", position: 1, name: "A" }] })))).toEqual([]);
    expect(run("SD-003", pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "BreadcrumbList", itemListElement: [{ "@type": "ListItem", position: 1, name: "A" }] })))[0].evidence.gaps).toEqual([expect.objectContaining({ type: "ListItem", missing: ["item"] })]);
    // A stand-alone Offer is not a Google feature by itself.
    expect(run("SD-003", pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Offer" })))).toEqual([]);
    // LocalBusiness subtypes use LocalBusiness's list; @graph entries are top-level entities.
    expect(run("SD-003", pageFrom("/x/", ld({ "@context": "https://schema.org", "@graph": [{ "@type": "Restaurant", name: "Cafe" }] })))[0].evidence.gaps).toEqual([expect.objectContaining({ type: "Restaurant", missing: ["address"] })]);
  });

  it("IMG-003 takes a plain-word alt matching the file name as a name; IMG-007 skips images that fill their parent", () => {
    expect(run("IMG-003", pageFrom("/x/", IMGTAG('src="https://cdn.test/show/331488/mongodb.svg" alt="MongoDB" width="10" height="10"')))).toEqual([]);
    expect(run("IMG-003", pageFrom("/x/", IMGTAG('src="/img/hero-banner_2.png" alt="hero-banner_2" width="10" height="10"')))).toHaveLength(1);
    const fill = 'src="/a.png" alt="A spade" style="position:absolute;height:100%;width:100%;left:0;top:0"';
    expect(run("IMG-007", pageFrom("/x/", IMGTAG(fill)))).toEqual([]);
    expect(run("IMG-007", pageFrom("/x/", IMGTAG('src="/a.png" alt="A spade" style="width:100%"')))).toHaveLength(1);
  });

  it("LNK-001 never reports a CDN-managed target (recorded by the crawl, not fetched)", () => {
    const cdn = { ...other("/cdn-cgi/l/email-protection", "cdn_managed", 90), statusCode: null };
    expect(run("LNK-001", pageFrom("/x/", withBody('<a href="/cdn-cgi/l/email-protection#6a0b">[email protected]</a>')), crawlOf(), { site: cleanSite(cdn) })).toEqual([]);
    expect(run("LNK-001", pageFrom("/x/", withBody('<a href="/cdn-cgi/l/email-protection">x</a>')), crawlOf(), { site: cleanSite(bare("/cdn-cgi/l/email-protection", 404)) })).toHaveLength(1); // the rule itself still reports a 404
  });

  it("LNK-014 counts the site's own query-string URLs only", () => {
    const ext = Array.from({ length: 150 }, (_, i) => ({ ...other(`/f?c=${i}`, "out_of_scope", 10 + i), url: `https://wa.me/971500000000?text=${i}` }));
    expect(run("LNK-014", cleanSite(...ext))).toEqual([]);
  });

  it("SD rules never claim rich-result eligibility", () => {
    for (const r of RULES.filter((x) => x.category === "structured_data")) {
      expect(`${r.explain.why} ${r.explain.fix} ${r.explain.acceptance}`, r.id).not.toMatch(/eligible|eligibility|will (show|appear|get)/i);
    }
    const f = run("SD-003", pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Event", name: "Show" })))[0];
    expect(f.message).not.toMatch(/eligib/i);
    expect(f.evidence.note).toMatch(/does not by itself make a page eligible/);
  });

  it("SD-002 ignores other vocabularies and prefixed properties", () => {
    expect(run("SD-002", pageFrom("/x/", ld({ "@context": "https://example.org/vocab", "@type": "Widget", colour: "red" })))).toEqual([]);
    // schema.org Action annotations: "<property>-input" / "-output" of a known property (example-client.ae validation).
    const search = (k: string) => pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "WebSite", url: U("/"), potentialAction: { "@type": "SearchAction", target: U("/s?q={q}"), [k]: "required name=q" } }));
    expect(run("SD-002", search("query-input"))).toEqual([]);
    expect(run("SD-002", search("qurey-input"))[0].evidence.properties).toEqual(["qurey-input"]);
    expect(run("SD-002", pageFrom("/x/", ld({ "@context": "https://schema.org", "@type": "Thing", name: "Spade", "og:x": 1 })))).toEqual([]);
  });

  it("SEC-003 reports an expired certificate and a handshake that failed", () => {
    expect(run("SEC-003", cleanSite(), crawlOf({ probes: [tls(-1)] }))[0].message).toMatch(/expired/);
    const failed = probe("tls_cert", U("/"), { status: null, error: { code: "TLS", message: "TLS connection failed." } });
    expect(run("SEC-003", cleanSite(), crawlOf({ probes: [failed] }))[0]).toMatchObject({ outcome: "inconclusive" });
  });

  it("SEC-006 is inconclusive when robots.txt kept the probe from being sent, and never on a 200 without a signature", () => {
    const skipped = probe("env_file", U("/.env"), { started: false, status: null, skipped: "blocked by robots.txt", skipCode: "probe_skipped_robots" });
    expect(run("SEC-006", cleanSite(), crawlOf({ probes: [skipped] }))[0]).toMatchObject({ outcome: "inconclusive", evidence: { code: "probe_skipped_robots" } });
    const f = run("SEC-006", cleanSite(), crawlOf({ probes: [exposed("git_head", { pattern: "git_head_ref", lines: 1 })] }))[0];
    expect(f.evidence).toEqual({ status: 200, pattern: "git_head_ref", matchedLines: 1 });
  });

  it("SEC-004 and SEC-005 judge the start page only", () => {
    expect(run("SEC-004", pageFrom("/x/"))).toEqual([]);
    expect(run("SEC-005", pageFrom("/x/"))).toEqual([]);
  });

  it("SITE-001 needs at least 5 pages in the template group", () => {
    expect(run("SITE-001", cleanSite(...templated(4, "T1")), crawlOf(), { pageIssues: issues("IMG-007", "T1", 4) })).toEqual([]);
    const [f] = run("SITE-001", cleanSite(...templated(300, "T1")), crawlOf(), { pageIssues: issues("IMG-007", "T1", 300) });
    expect(f.evidence).toMatchObject({ ruleId: "IMG-007", pages: 300, groupSize: 300, share: 1 });
  });
});

describe("details", () => {
  it("AIS-002 needs the AI crawler setting when it is not set", () => {
    expect(() => run("AIS-002", cleanSite(), crawlOf())).toThrow(NeedsConfig);
  });

  it("AIS-003 flags an llms.txt served as HTML", () => {
    const f = run("AIS-003", cleanSite(), crawlOf({ probes: [probe("llms_txt", U("/llms.txt"), { contentType: "text/html", body: "<!doctype html>" })] }));
    expect(f[0].evidence).toMatchObject({ reason: "malformed" });
  });

  it("CNT-009 v2 matches two-letter terms, word forms and words split by <br> (example-client.ae false positives)", () => {
    const pair = (title: string, h1: string) => run("CNT-009", pageFrom("/x/", { title: `<title>${title}</title>`, h1: `<h1>${h1}</h1>` }));
    expect(pair("AI Cost Optimization Dubai", "Find Where Your AI Is Wasting Money")).toEqual([]);
    expect(pair("UI/UX Design Dubai", "Stop Designing for Dribbble")).toEqual([]);
    expect(pair("Web Design That Pays", "A Website That<br/>Pays for Itself.")).toEqual([]);
    expect(pair("AI Visibility Audit", "When Customers Ask AI<br/>Who to Choose")).toEqual([]);
    // Still an issue when nothing is shared, and two-letter function words do not count as shared.
    expect(pair("Blogs | Garden Club", "Our Insights &amp; Stories")).toHaveLength(1);
    expect(pair("Go to the garden", "Go home if it rains")).toHaveLength(1);
    expect(meaningfulTerms("Designing designed designs")).toEqual(new Set(["design"]));
  });

  it("CNT-007 does not report exact duplicates (those are CNT-006)", () => {
    expect(run("CNT-007", cleanSite(pageFrom("/d1/", { title: "<title>Duplicate one garden page</title>" }), pageFrom("/d2/", { title: "<title>Duplicate two garden page</title>" })))).toEqual([]);
  });

  it("CNT-007 compares main content only: shared landmark boilerplate does not make distinct pages near duplicates", () => {
    // A page builder's layout: no <main>, furniture in <div role=...>. About 2,400 shared words, ~120 distinct ones each.
    const shell = (key: string) => ({
      title: `<title>${key} garden page title</title>`,
      h1: `<h1>${key} heading</h1>`,
      body: `<div role="navigation">${paragraph("shared-nav", 1500)}</div><div class="content"><p>${paragraph(`main:${key}`, 120)}</p></div><div role="contentinfo">${paragraph("shared-footer", 900)}</div>`,
    });
    const a = pageFrom("/b1/", shell("first"));
    const b = pageFrom("/b2/", shell("second"));
    expect(a.wordCount).toBeGreaterThanOrEqual(NEAR_DUPLICATE_MIN_WORDS);
    expect(a.wordCount).toBeLessThan(200); // the landmarks were stripped from the main text
    // With the furniture left in, the two pages would be near duplicates; on main content they are not.
    const whole = (p: PageView) => simhash(parseHtml(html({ ...clean("/"), ...shell(p.url.includes("b1") ? "first" : "second") }))("body").text())!;
    expect(simhashSimilarity(whole(a), whole(b))).toBeGreaterThanOrEqual(NEAR_DUPLICATE);
    expect(run("CNT-007", cleanSite(a, b))).toEqual([]);
  });

  it("CNT-007 needs at least 100 main-content words on both pages", () => {
    const short = (path: string, word: string) => pageFrom(path, { title: `<title>Short ${word} garden page</title>`, h1: "", body: `<main><p>${paragraph("short-shared", 90)} ${word}</p></main>` });
    const a = short("/s1/", "orchard");
    const b = short("/s2/", "lantern");
    expect(a.wordCount).toBeLessThan(NEAR_DUPLICATE_MIN_WORDS);
    expect(simhashSimilarity(a.simhash!, b.simhash!)).toBeGreaterThanOrEqual(NEAR_DUPLICATE);
    expect(run("CNT-007", cleanSite(a, b))).toEqual([]);
  });

  it("CNT-007 fires at 0.92 similarity and above, and reports the similarity", () => {
    const pos = CASES["CNT-007"].pos();
    expect(pos.length).toBe(2);
    for (const f of pos) expect((f.evidence as { matches: { similarity: number }[] }).matches[0].similarity).toBeGreaterThanOrEqual(0.92);
    expect(NEAR_DUPLICATE).toBe(0.92);
  });

  it("IDX-012 treats an unfetched canonical target as inconclusive", () => {
    expect(run("IDX-012", cleanSite(pageFrom("/c/", { canonical: `<link rel="canonical" href="${U("/private/x")}">` }), other("/private/x", "blocked_robots", 10)))).toEqual([]);
  });

  it("META-012 reports a low-confidence mismatch as inconclusive, and stays silent when the detector agrees", () => {
    const mixed = pageFrom("/x/", { lang: ' lang="en"', h1: "", body: `<main><p>${MIXED_PROSE}</p></main>` });
    expect(mixed.language).toMatchObject({ detected: "es" });
    expect(mixed.language!.accuracy!).toBeLessThan(LANGUAGE_MIN_ACCURACY);
    const [f, ...rest] = run("META-012", mixed);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ ruleId: "META-012", outcome: "inconclusive", evidence: { code: "low_confidence", declared: "en", detected: "es", reason: "mismatch" } });
    // Same text declared Spanish: the detector agrees, so nothing to report whatever its confidence.
    expect(run("META-012", pageFrom("/x/", { lang: ' lang="es"', h1: "", body: `<main><p>${MIXED_PROSE}</p></main>` }))).toEqual([]);
    // A confident mismatch is still an issue.
    expect(run("META-012", pageFrom("/x/", { lang: ' lang="fr"', h1: "", body: `<main><p>${ENGLISH_PROSE}</p></main>` }))[0]).toMatchObject({ outcome: "issue" });
  });

  it("META-012 does not judge the language of short text", () => {
    expect(run("META-012", pageFrom("/x/", { lang: ' lang="fr"', body: `<main><p>${textOf(5)}</p></main>` }))).toEqual([]);
  });

  it("META-015 flags a meta charset after the first 1024 bytes", () => {
    const f = run("META-015", pageFrom("/x/", { charset: "", head: `<!--${"x".repeat(1100)}--><meta charset="utf-8">` }, { headers: { "content-type": "text/html" } }));
    expect(f[0].evidence).toMatchObject({ reason: "late" });
  });
});
