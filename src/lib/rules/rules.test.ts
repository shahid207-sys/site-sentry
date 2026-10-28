// Every catalog rule: one positive case (fires) and one negative case (silent), plus a clean page and a clean
// site that no rule fires on. Pages are built by the real extractor from HTML, so these also exercise extraction.
import { describe, expect, it } from "vitest";
import { parseHtml } from "../audit/parse";
import { extractOutlinks, type SitemapDocRecord } from "../crawl/v2/discovery";
import type { RobotsRecord } from "../crawl/v2/runner";
import type { DiscoverySource, UrlState } from "../crawl/v2/types";
import { extractHtml } from "../snapshot/extract";
import { crawlView, effectiveCanonical } from "./analyse";
import { NeedsConfig, type CrawlView, type Finding, type PageView, type Rule, type SiteView, type UrlFacts } from "./contract";
import { LEGACY_TO_CATALOG } from "./legacy-map";
import type { ProbeRecord } from "./probe-types";
import { DEFERRED_RULES, RULES, RULES_BY_ID } from "./registry";
import { NEAR_DUPLICATE, NEAR_DUPLICATE_MIN_WORDS } from "./cnt";
import { simhash, simhashSimilarity } from "../snapshot/text";
import { paragraph } from "../../../fixtures/site/text";
import { ENGLISH_PROSE, MIXED_PROSE } from "../../../fixtures/site/defects";
import { LANGUAGE_MIN_ACCURACY } from "./meta";

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

/** The site-rule projection of a page, as analyse.ts loads it. */
function facts(p: PageView, id: number): UrlFacts {
  return {
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
        }
      : null,
  };
}
const redirect = (path: string, status: number, to: string, id: number): UrlFacts => ({ id, url: U(path), state: "redirected", statusCode: status, redirectTarget: U(to), discoveredVia: ["link"], page: null });
const other = (path: string, state: UrlState, id: number, via: DiscoverySource[] = ["link"]): UrlFacts => ({ id, url: U(path), state, statusCode: null, redirectTarget: null, discoveredVia: via, page: null });

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
}
function crawlOf(o: CrawlOpts = {}): CrawlView {
  const robots: RobotsRecord | null =
    o.robots === null ? null : { url: U("/robots.txt"), started: true, status: 200, outcome: "parsed", body: o.robotsBody ?? ROBOTS_OK, sitemaps: [U("/sitemap.xml")], ...o.robots };
  return crawlView({
    id: "c1",
    site_origin: ORIGIN,
    status: "completed",
    config: o.aiCrawlers ? { aiCrawlers: o.aiCrawlers } : {},
    robots,
    sitemaps: o.sitemaps ?? [sitemap()],
    probes: o.probes ?? GOOD_PROBES,
    started_at: new Date("2026-06-01T00:00:00Z"),
    created_at: new Date("2026-06-01T00:00:00Z"),
  });
}

const rule = (id: string): Rule => {
  const r = RULES_BY_ID.get(id);
  if (!r) throw new Error(`no rule ${id}`);
  return r;
};
function run(id: string, x: PageView | SiteView, crawl: CrawlView = crawlOf()): Finding[] {
  const r = rule(id);
  if (r.scope === "page") {
    if (!("html" in x)) throw new Error(`${id} is a page rule`);
    return r.evaluate({ page: x, crawl });
  }
  if ("html" in x) throw new Error(`${id} is a site rule`);
  return r.evaluate({ site: x, crawl });
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
};

describe("rule catalog", () => {
  it("every registered rule has a test case, and every case names a registered rule", () => {
    expect(Object.keys(CASES).sort()).toEqual(RULES.map((r) => r.id).sort());
    expect(RULES.length).toBe(31 + 19 + 12 + 3);
    expect(Object.keys(DEFERRED_RULES)).toEqual(["IDX-018"]);
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
    const found = RULES.filter((r) => r.scope === "page").flatMap((r) => (r.scope === "page" ? r.evaluate({ page, crawl }) : []));
    expect(found).toEqual([]);
  });

  it("no site rule fires on a clean site (AIS-001 reports robots.txt, not a page)", () => {
    const site = cleanSite();
    const crawl = crawlOf({ aiCrawlers: "allow" });
    const found = RULES.filter((r) => r.scope === "site").flatMap((r) => (r.scope === "site" ? r.evaluate({ site, crawl }) : []));
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

describe("details", () => {
  it("AIS-002 needs the AI crawler setting when it is not set", () => {
    expect(() => run("AIS-002", cleanSite(), crawlOf())).toThrow(NeedsConfig);
  });

  it("AIS-003 flags an llms.txt served as HTML", () => {
    const f = run("AIS-003", cleanSite(), crawlOf({ probes: [probe("llms_txt", U("/llms.txt"), { contentType: "text/html", body: "<!doctype html>" })] }));
    expect(f[0].evidence).toMatchObject({ reason: "malformed" });
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
