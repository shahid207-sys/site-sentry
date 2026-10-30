// Phase 2b defects on the fixture site (docs/SPEC.md "Phase 2", Part C): links, depth, orphans, images, structured
// data, hreflang, the /products/ template defect and security. As in defects.ts, the expected findings are declared by
// hand, cascades included, so the gate compares the crawl with something the rule code did not compute.
//
// Graph structure (who links to whom) lives in server.ts: every page of an index-linked section links to its previous
// and next page in a <nav>, so each has two inbound links and LNK-005 stays silent unless a page is meant to fire it.
import type { Defect, RuleId } from "./defects";
import { EXT_HOSTS, manifestPaths, ROBOTS_BLOCKED_PREFIX, SECTIONS, sectionPaths } from "./definition";
import { links, organization, png, SITE_NAME, type Parts } from "./pages";
import { paragraph, topic } from "./text";

const ld = (...blocks: unknown[]) => blocks.map((b) => `<script type="application/ld+json">${typeof b === "string" ? b : JSON.stringify(b)}</script>`).join("");
const SCHEMA_ORG = "https://schema.org";
/** Another fixture host's origin, same port and scheme as `origin`. */
export const hostOrigin = (origin: string, host: string) => origin.replace(/\/\/[^:/]+/, `//${host}`);
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// ---------- /links/ ----------

/** LNK-010 budget: more unique external URLs than the resource phase may check (500). */
export const EXTERNAL_LINK_URLS = 520;
const EXTERNAL_PER_PAGE = EXTERNAL_LINK_URLS / 2;
/** LNK-014: distinct query strings under /links/filter, one past the threshold; excluded from the crawl's scope. */
export const FACET_LINKS = 101;
export const FACET_PATH = "/links/filter";

/** 305 distinct internal targets, all 200 pages: /clean/ (100), /links/ (120), /meta/ (60), /index/ (25). */
const manyTargets = () => [...sectionPaths(section("/clean/")), ...sectionPaths(section("/links/")), ...sectionPaths(section("/meta/")), ...sectionPaths(section("/index/")).slice(0, 25)];

const LINKS: Defect[] = [
  ...range(1, 10).map(
    (i): Defect => ({
      name: `broken internal link and a link to a redirect (${i})`,
      expect: ["LNK-001", "LNK-002"],
      apply: (p) => void (p.body += `<p><a href="/links/missing-${i}">Retired guide ${i}</a> and <a href="/redirects/s301-1">the moved guide</a>.</p>`),
    }),
  ),
  { name: "internal nofollow", expect: ["LNK-006"], apply: (p) => void (p.body += '<p><a href="/clean/p-1" rel="nofollow">Clean page one</a></p>') },
  { name: "generic anchor text", expect: ["LNK-007"], apply: (p) => void (p.body += '<p><a href="/clean/p-2">Click here</a></p>') },
  { name: "over 300 links", expect: ["LNK-008"], apply: (p) => void (p.body += links(manyTargets())) },
  {
    name: "broken external link",
    expect: [], // LNK-010 reports the external URL (EXTERNAL_EXPECTATIONS), not the page
    apply: (p, c) => void (p.body += `<p><a href="${hostOrigin(c.origin, EXT_HOSTS.ext2)}/gone">Archived partner page</a></p>`),
  },
  // The http URL 301s to https, so it is also a link to a redirect.
  { name: "http internal link", expect: ["LNK-011", "LNK-002"], apply: (p, c) => void (p.body += `<p><a href="${c.origin.replace("https:", "http:")}/clean/p-3">Clean page three</a></p>`) },
  { name: 'rel="next" without a link', expect: ["LNK-013"], apply: (p) => void (p.head += '<link rel="next" href="/links/p-40">') },
  ...[0, 1].map(
    (k): Defect => ({
      name: `external links over the budget (${k + 1}/2)`,
      expect: [],
      apply: (p, c) => {
        const o = hostOrigin(c.origin, EXT_HOSTS.ext);
        // The partner list sits outside <main>, with long prose inside it: otherwise the two pages are near duplicates.
        p.text = `<p>${paragraph(`ext:${c.path}`, 3000)}</p>`;
        p.footer = `<aside><ul>${range(k * EXTERNAL_PER_PAGE + 1, (k + 1) * EXTERNAL_PER_PAGE)
          .map((n) => `<li><a href="${o}/page-${n}">${topic(`partner:${n}`)}</a></li>`)
          .join("")}</ul></aside>${p.footer}`;
      },
    }),
  ),
  {
    name: "faceted links (crawl trap)",
    expect: [], // LNK-014 reports the path (FACET_PATH)
    apply: (p) => void (p.body += `<ul>${range(1, FACET_LINKS).map((n) => `<li><a href="${FACET_PATH}?c=${n}">Filter ${n}</a></li>`).join("")}</ul>`),
  },
  {
    // The fixture answers 404 on every /cdn-cgi/ path, as Cloudflare does to a crawler: recorded as cdn_managed, never
    // fetched, so no LNK-001 (example-client.ae validation).
    name: "Cloudflare email-protection and other /cdn-cgi/ links (negative)",
    expect: [],
    apply: (p) => void (p.body += `<p>Write to <a href="${CDN_LINKS[0]}#6a0b0e07">[email&#160;protected]</a> or check <a href="${CDN_LINKS[1]}">the edge trace</a>.</p>`),
  },
  {
    name: "descriptive internal and nofollow external links (negative)",
    expect: [],
    apply: (p, c) => void (p.body += `<p><a href="/clean/p-4">Clean page four</a> and <a href="${hostOrigin(c.origin, EXT_HOSTS.ext2)}/ok" rel="nofollow">a partner site</a>.</p>`),
  },
];

/** CDN-injected paths linked from one /links/ page (crawl state cdn_managed, never requested). */
export const CDN_LINKS = ["/cdn-cgi/l/email-protection", "/cdn-cgi/trace"] as const;

/** fixture.test's crawl scope excludes: the /products/ facet trap (a Phase 1 subject that never ends) and the LNK-014
 * filter links, which the crawl records as excluded_by_rule rows without fetching them. */
export const MAIN_EXCLUDE = [String.raw`^https://fixture\.test:\d+/products/\?`, String.raw`^https://fixture\.test:\d+/links/filter\?`];

/** Absolute URL of a manifest path: the plain-http page is the one main-host page served over http. */
export const urlOf = (origin: string, path: string) => new URL(path, path === PLAIN_HTTP_PAGE ? origin.replace("https:", "http:") : origin).toString();

/** The crawl's keyPages setting (LNK-012): the home page (high PageRank, silent) and an orphan (positive). */
export const KEY_PAGES = ["/", "/orphans/p-1"];

// ---------- /images/ ----------

/** Unique image URLs on the budget pages: more than the resource phase may check (2,000). */
export const IMAGE_BUDGET_URLS = 2_100;
const IMAGES_PER_BUDGET_PAGE = 700;
/** Budget pages, one level below /images/ (linked from its last two pages), so their images come after the defects'. */
export const IMAGE_BUDGET_PAGES = range(1, IMAGE_BUDGET_URLS / IMAGES_PER_BUDGET_PAGE).map((i) => `/images/budget-${i}`);

/** Every image the fixture serves, by path; anything else under /img/ is a 404 (the IMG-004 positive). */
export function imageFile(path: string): { type: string; body: Buffer } | null {
  if (path === "/img/plain.png" || path === "/img/IMG_2041.png") return { type: "image/png", body: png(400, 300) };
  if (path === "/img/wide.png") return { type: "image/png", body: png(1200, 800) };
  if (path === "/img/product.png") return { type: "image/png", body: png(400, 400) };
  if (path === "/img/dot.png") return { type: "image/png", body: png(20, 15) }; // decorative: small, empty alt is right
  if (path === "/img/heavy.webp") return { type: "image/webp", body: Buffer.alloc(300 * 1024, 1) }; // over 200 KB
  if (path === "/img/legacy.jpg") return { type: "image/jpeg", body: Buffer.alloc(150 * 1024, 1) }; // a large JPEG
  if (/^\/img\/b\/\d+\.png$/.test(path)) return { type: "image/png", body: png(10, 10) };
  return null;
}

const img = (attrs: string) => (p: Parts) => void (p.body += `<p><img ${attrs}></p>`);
const IMAGES: Defect[] = [
  { name: "image without alt", expect: ["IMG-001"], apply: img('src="/img/plain.png" width="400" height="300"') },
  { name: "large content image with empty alt", expect: ["IMG-002"], apply: img('src="/img/plain.png" alt="" width="400" height="300"') },
  { name: "file name as alt", expect: ["IMG-003"], apply: img('src="/img/IMG_2041.png" alt="IMG_2041.png" width="400" height="300"') },
  { name: "broken image", expect: [], apply: img('src="/img/missing.png" alt="A garden spade" width="400" height="300"') }, // IMG-004 on the image URL
  { name: "image over 200 KB", expect: [], apply: img('src="/img/heavy.webp" alt="A garden spade" width="400" height="300"') }, // IMG-005 on the image URL
  { name: "large JPEG", expect: [], apply: img('src="/img/legacy.jpg" alt="A garden spade" width="400" height="300"') }, // IMG-006 on the image URL
  { name: "image without dimensions", expect: ["IMG-007"], apply: img('src="/img/plain.png" alt="A garden spade"') },
  // In <picture>, so IMG-010 (no srcset) stays silent and the page fires IMG-008 alone.
  { name: "image four times its display width", expect: ["IMG-008"], apply: (p) => void (p.body += '<picture><source srcset="/img/wide.png" media="(min-width: 1200px)"><img src="/img/wide.png" alt="A garden spade" width="300" height="200"></picture>') },
  { name: "wide image without srcset", expect: ["IMG-010"], apply: img('src="/img/wide.png" alt="A garden spade" width="600" height="400"') },
  { name: "video without poster", expect: ["IMG-011"], apply: (p) => void (p.body += '<video src="/img/clip.mp4" controls></video>') },
  {
    name: "well-formed images (negative)",
    expect: [],
    apply: (p) => {
      p.body +=
        '<p><img src="/img/wide.png" srcset="/img/wide.png 1200w, /img/plain.png 400w" sizes="(max-width: 600px) 400px, 600px" alt="A garden spade" width="600" height="400"></p>' +
        '<video src="/img/clip.mp4" poster="/img/plain.png" controls></video>';
      // A small decorative image outside the main content: empty alt is right there.
      p.footer = p.footer.replace("</footer>", '<img src="/img/dot.png" alt="" width="20" height="15"></footer>');
    },
  },
];

/** A budget page: 700 small images with alt text and dimensions, and enough prose that CNT-012 (text ratio) stays silent. */
export function imageBudgetBody(path: string): string {
  const k = Number(path.slice("/images/budget-".length)) - 1;
  const tags = range(k * IMAGES_PER_BUDGET_PAGE + 1, (k + 1) * IMAGES_PER_BUDGET_PAGE).map((n) => `<img src="/img/b/${n}.png" alt="Seed tray ${n}" width="10" height="10">`);
  return `<p>${paragraph(`budget:${path}`, 1200)}</p><p>${tags.join("")}</p>`;
}

// ---------- /schema/ ----------

/** Three path segments deep, for SD-008: one without a BreadcrumbList (positive), one with (negative). */
export const SCHEMA_DEEP = ["/schema/guides/no-trail", "/schema/guides/with-trail"];

const SCHEMA: Defect[] = [
  { name: "invalid JSON-LD", expect: ["SD-001"], apply: (p) => void (p.head += ld('{"@context": "https://schema.org", "@type": "Thing",}')) },
  { name: "unknown schema.org property", expect: ["SD-002"], apply: (p) => void (p.head += ld({ "@context": SCHEMA_ORG, "@type": "Thing", name: "Spade", nmae: "Spade" })) },
  {
    name: "Event without startDate",
    expect: ["SD-003"],
    apply: (p, c) =>
      void (p.head += ld({
        "@context": SCHEMA_ORG,
        "@type": "Event",
        name: "Seed swap",
        description: "Bring seeds, take seeds.",
        endDate: "2026-07-01T17:00:00+01:00",
        eventStatus: "https://schema.org/EventScheduled",
        image: `${c.origin}/img/plain.png`,
        location: { "@type": "Place", name: "Hall", address: "1 Garden Road" },
        offers: offer(),
        organizer: { "@type": "Organization", name: SITE_NAME, url: `${c.origin}/` },
        performer: { "@type": "Person", name: "A. Gardener" },
      })),
  },
  { name: "Article without recommended properties", expect: ["SD-004"], apply: (p) => void (p.head += ld({ "@context": SCHEMA_ORG, "@type": "Article", headline: "Sharpening a spade" })) },
  {
    name: "two Organization blocks that disagree",
    expect: ["SD-005"],
    apply: (p, c) => void (p.head += ld(organization(c.origin, SITE_NAME), organization(c.origin, "Fixture Garden Supplies"))),
  },
  {
    name: "rating not shown on the page",
    expect: ["SD-006"],
    apply: (p, c) => void (p.head += ld(product(c.origin))),
  },
  {
    name: "Product without offers",
    expect: ["SD-009", "SD-004"], // offers (and aggregateRating) are also recommended properties
    apply: (p) => {
      p.head += ld({ "@context": SCHEMA_ORG, "@type": "Product", name: "Spade", review: review() });
      p.body += `<p>${RATING_TEXT.review}</p>`;
    },
  },
  { name: "deprecated type", expect: ["SD-010"], apply: (p) => void (p.head += ld({ "@context": SCHEMA_ORG, "@type": "HowTo", name: "Sharpen a spade" })) },
  {
    name: "complete Product with a visible rating (negative)",
    expect: [],
    apply: (p, c) => {
      p.head += ld(product(c.origin));
      p.body += `<p>${RATING_TEXT.aggregate} ${RATING_TEXT.review}</p>`;
    },
  },
  {
    name: "complete Article (negative)",
    expect: [],
    apply: (p, c) =>
      void (p.head += ld({
        "@context": SCHEMA_ORG,
        "@type": "Article",
        headline: "Sharpening a spade",
        image: `${c.origin}/img/plain.png`,
        datePublished: "2026-03-01T09:00:00Z",
        dateModified: "2026-03-02T09:00:00Z",
        author: { "@type": "Person", name: "A. Gardener", url: `${c.origin}/clean/` },
      })),
  },
];
function offer() {
  return { "@type": "Offer", price: "25.00", priceCurrency: "GBP", availability: "https://schema.org/InStock", priceValidUntil: "2027-01-01" };
}
function review() {
  return { "@type": "Review", author: { "@type": "Person", name: "A. Gardener" }, datePublished: "2026-03-01", reviewRating: { "@type": "Rating", ratingValue: 5, bestRating: 5, worstRating: 1 } };
}
/** A Product with every property Google requires or recommends. */
function product(origin: string) {
  return {
    "@context": SCHEMA_ORG,
    "@type": "Product",
    name: "Spade",
    image: `${origin}/img/plain.png`,
    offers: offer(),
    aggregateRating: { "@type": "AggregateRating", ratingValue: "4.8", reviewCount: "212", bestRating: "5", worstRating: "1" },
    review: review(),
  };
}
/** The visible text that matches the ratings in product() and review() (SD-006). */
const RATING_TEXT = { aggregate: "Rated 4.8 out of 5 from 212 reviews.", review: "A. Gardener rated it 5 out of 5." };

export function schemaDeepParts(p: Parts, path: string, origin: string) {
  if (path.endsWith("/with-trail")) {
    p.head += ld({
      "@context": SCHEMA_ORG,
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Schema", item: `${origin}/schema/` },
        { "@type": "ListItem", position: 2, name: "With trail", item: `${origin}${path}` },
      ],
    });
  }
}

// ---------- /intl/ ----------

/** hreflang target that answers 404 (I18N-001). */
export const INTL_MISSING = "/intl/missing-de";
type Alt = [lang: string, path: string];
const hreflang = (alts: Alt[]) => (p: Parts) => void (p.head += alts.map(([l, h]) => `<link rel="alternate" hreflang="${l}" href="${h}">`).join(""));
const TRIO: Alt[] = [
  ["en", "/intl/p-1"],
  ["de", "/intl/p-2"],
  ["fr", "/intl/p-3"],
  ["x-default", "/intl/p-1"],
];

const INTL: Defect[] = [
  { name: "reciprocal set en (negative)", expect: [], apply: hreflang(TRIO) },
  { name: "reciprocal set de (negative)", expect: [], apply: hreflang(TRIO) },
  { name: "reciprocal set fr (negative)", expect: [], apply: hreflang(TRIO) },
  { name: "hreflang target 404", expect: ["I18N-001"], apply: hreflang([["en", "/intl/p-4"], ["de", INTL_MISSING], ["x-default", "/intl/p-4"]]) },
  { name: "no return link (source)", expect: ["I18N-002"], apply: hreflang([["en", "/intl/p-5"], ["de", "/intl/p-6"], ["x-default", "/intl/p-5"]]) },
  { name: "no return link (target)", expect: [], apply: hreflang([["de", "/intl/p-6"], ["x-default", "/intl/p-6"]]) },
  { name: "invalid language code", expect: ["I18N-003"], apply: hreflang([["en-UK", "/intl/p-7"], ["x-default", "/intl/p-7"]]) },
  { name: "no self reference", expect: ["I18N-004"], apply: hreflang([["de", "/intl/p-9"], ["x-default", "/intl/p-9"]]) },
  { name: "self-referencing partner", expect: [], apply: hreflang([["de", "/intl/p-9"], ["en", "/intl/p-8"], ["x-default", "/intl/p-9"]]) },
  { name: "no x-default", expect: ["I18N-005"], apply: hreflang([["en", "/intl/p-10"]]) },
  { name: "target canonicalised elsewhere (source)", expect: ["I18N-006"], apply: hreflang([["en", "/intl/p-11"], ["de", "/intl/p-12"], ["x-default", "/intl/p-11"]]) },
  {
    name: "target canonicalised elsewhere (target)",
    expect: ["IDX-029", "I18N-006"], // a sitemap URL that canonicalises elsewhere, and its own hreflang names itself
    apply: (p, c) => {
      hreflang([["de", "/intl/p-12"], ["en", "/intl/p-11"], ["x-default", "/intl/p-11"]])(p);
      p.canonical = `<link rel="canonical" href="${c.origin}/intl/p-11">`;
    },
  },
];

// ---------- /products/: one template defect on all 300 pages ----------

/** The product template: its own wrapper, and a product photo without width and height on every page (IMG-007). */
const PRODUCT: Defect = {
  name: "product template: photo without dimensions",
  expect: ["IMG-007"],
  apply: (p) => {
    p.body += links(["/products/"]); // every product page has the same list as the index, so all 300 share one template
    p.wrap = ['<article class="product"><div class="gallery"><img src="/img/product.png" alt="Product photo"></div><section>', "</section></article>"];
  },
};

// ---------- /security/ ----------

/** A page served over plain http only (SEC-001), linked with http:// URLs (LNK-011) from two /security/ pages. */
export const PLAIN_HTTP_PAGE = "/security/plain";
/** The /.env body: a real KEY=value file with a canary value the gate greps the database and blob store for. */
export const ENV_CANARY = "SITESENTRY_CANARY_6f1d2c0b9a";
export const ENV_BODY = `APP_ENV=production\nDB_HOST=db.internal\nDB_PASSWORD=${ENV_CANARY}\nSTRIPE_KEY=sk_test_${ENV_CANARY}\n`;
export const GIT_HEAD_BODY = "ref: refs/heads/main\n";

const httpLink = (p: Parts, c: { origin: string }) => void (p.body += `<p><a href="${c.origin.replace("https:", "http:")}${PLAIN_HTTP_PAGE}">The plain http page</a></p>`);
const SECURITY: Defect[] = [
  // PERF-005: a classic head script also blocks rendering.
  { name: "mixed content script", expect: ["SEC-002", "PERF-005"],
    apply: (p, c) => void (p.head += `<script src="${c.origin.replace("https:", "http:")}/assets/app.js"></script>`) },
  { name: "http link to the plain page (1/2)", expect: ["LNK-011"], apply: httpLink },
  { name: "http link to the plain page (2/2)", expect: ["LNK-011"], apply: httpLink },
];

// ---------- table ----------

function section(path: string) {
  return SECTIONS.find((s) => s.path === path)!;
}

/** Page path → defect for the 2b sections. Defects take the first pages of their section (p-1, p-2…). */
export const DEFECTS_2B: Record<string, Defect> = (() => {
  const out: Record<string, Defect> = {};
  for (const [s, list] of [["/links/", LINKS], ["/images/", IMAGES], ["/schema/", SCHEMA], ["/intl/", INTL], ["/security/", SECURITY]] as const) {
    list.forEach((d, i) => (out[`${s}p-${i + 1}`] = d));
  }
  for (const p of sectionPaths(section("/products/"))) out[p] = PRODUCT;
  return out;
})();

export const DEFECT_COUNTS_2B = { links: LINKS.length, images: IMAGES.length, schema: SCHEMA.length, intl: INTL.length, security: SECURITY.length };

/** Index-linked pages of the 2b sections that are not in the manifest (served, linked, not in any sitemap). */
export const EXTRAS_2B = [...IMAGE_BUDGET_PAGES, ...SCHEMA_DEEP];

/**
 * Findings the 2b structure produces on pages without a defect of their own, by path: depth (LNK-004), orphans
 * (LNK-003), broken targets and the /products/ index's link count.
 */
export function structuralExpectations(): Map<string, RuleId[]> {
  const out = new Map<string, RuleId[]>();
  // /deep/: chain page d is at click depth d (home 0, /deep/ 1); its side pages one deeper. Deeper than 4 is LNK-004.
  for (const p of sectionPaths(section("/deep/"))) {
    const m = /^\/deep\/d-(\d+)(-s-\d+)?$/.exec(p);
    const depth = p === "/deep/" ? 1 : Number(m![1]) + (m![2] ? 1 : 0);
    out.set(p, depth > 4 ? ["LNK-004"] : []);
  }
  // /orphans/: listed in the sitemap, linked from nowhere.
  for (const p of sectionPaths(section("/orphans/"))) out.set(p, ["LNK-003"]);
  // A key page (KEY_PAGES) with less internal PageRank than the median page: the orphan has almost none.
  out.get(KEY_PAGES[1])!.push("LNK-012");
  // /js/: the index's links exist only after JavaScript runs, so the pages are orphans to a non-rendering crawler.
  for (const p of sectionPaths(section("/js/"))) out.set(p, p === "/js/" ? [] : ["LNK-003"]);
  for (const i of range(1, 10)) out.set(`/links/missing-${i}`, ["IDX-001"]);
  out.set("/index/", ["LNK-001"]); // it links the /index/ extras, two of them 404 and one 500
  out.set("/redirects/", ["LNK-002"]); // it links every redirect
  out.set(INTL_MISSING, ["IDX-001"]);
  // The index lists all 299 products, the listing's next-page and colour links, plus the header and nav: over 300.
  out.set("/products/", ["IMG-007", "LNK-008"]);
  // The pages 2b adds outside the sections are indexable and in no sitemap (IDX-032).
  out.set(PLAIN_HTTP_PAGE, ["SEC-001", "IDX-032"]);
  for (const p of EXTRAS_2B) out.set(p, p === SCHEMA_DEEP[0] ? ["SD-008", "IDX-032"] : ["IDX-032"]);
  // /security/admin/ (2a): listed in the sitemap but blocked by robots.txt. /security/ is an exact section from 2b on.
  for (const p of manifestPaths()) if (p.startsWith(ROBOTS_BLOCKED_PREFIX)) out.set(p, ["IDX-007"]);
  return out;
}

/** Findings reported on URLs that are not pages: external links and images (resource rules), probes, the facet path. */
export function resourceExpectations(origin: string): Map<string, RuleId[]> {
  return new Map([
    [`${hostOrigin(origin, EXT_HOSTS.ext2)}/gone`, ["LNK-010"]],
    [`${origin}/img/missing.png`, ["IMG-004"]],
    [`${origin}/img/heavy.webp`, ["IMG-005"]],
    [`${origin}/img/legacy.jpg`, ["IMG-006"]],
    [`${origin}${FACET_PATH}`, ["LNK-014"]],
    [`${origin}/.env`, ["SEC-006"]],
    [`${origin}/.git/HEAD`, ["SEC-006"]],
  ]);
}

