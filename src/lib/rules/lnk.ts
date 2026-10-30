// Internal and external link rules (docs/SPEC.md catalog, LNK). LNK-009 (links only via JS onclick) reads the
// render and lives in rendered.ts.
//
// Page rules judge a page's links by their targets in the crawl (SiteView); a target the crawl did not fetch is never
// reported. Graph rules read the site pass's inbound counts, click depth and PageRank (analyse.ts, graph.ts).
import { finding, inconclusive, inSitemap, isIndexable, NeedsConfig, type Finding, type PageRule, type PageView, type ResourceRule, type SiteRule, type UrlFacts } from "./contract";
import { homeUrl, isHtml200 } from "./util";

const page = (r: Omit<PageRule, "scope" | "category">): PageRule => ({ scope: "page", category: "links", ...r });
const site = (r: Omit<SiteRule, "scope" | "category">): SiteRule => ({ scope: "site", category: "links", ...r });

/** Evidence lists are capped; the count is always complete. */
const EVIDENCE_CAP = 20;
/** Spec: a page deeper than 4 clicks. */
export const MAX_CLICK_DEPTH = 4;
/** Spec: over 300 links on a page. */
export const MAX_LINKS = 300;
/** LNK-014: distinct query strings under one path before it counts as a crawl trap. */
export const FACET_TRAP_COMBOS = 100;

const isInternal = (url: string, origin: string) => {
  try {
    return new URL(url).hostname === new URL(origin).hostname;
  } catch {
    return false;
  }
};
/** <a href> / <area href> links of the page (not canonical, hreflang, pagination or iframe references). */
const anchors = (p: PageView) => p.links.filter((l) => l.via === "link");
/** Internal <a> link targets of the page, once each, self-links excluded. */
function internalTargets(p: PageView, origin: string): string[] {
  return [...new Set(anchors(p).filter((l) => l.href !== p.url && isInternal(l.href, origin)).map((l) => l.href))];
}

const LNK001 = page({
  id: "LNK-001",
  version: 1,
  confidence: "verified",
  impact: 4,
  needs: ["graph"],
  evaluate({ page: p, crawl, site: s }) {
    if (!isHtml200(p)) return [];
    const bad = internalTargets(p, crawl.origin)
      .map((t) => s.byUrl.get(t))
      .filter((t): t is UrlFacts => !!t && t.statusCode !== null && t.statusCode >= 400);
    if (!bad.length) return [];
    return [finding(LNK001, p.url, `Links to ${bad.length} internal URL(s) that return 4xx/5xx.`, { count: bad.length, targets: bad.slice(0, EVIDENCE_CAP).map((t) => ({ url: t.url, status: t.statusCode })) })];
  },
  explain: {
    why: "Links to error pages waste crawl budget, leak link equity and send visitors to dead ends.",
    fix: "Point each link at a live URL (the replacement page), or restore the target.",
    acceptance: "Every internal link on the page resolves to a 200 page.",
  },
});

const LNK002 = page({
  id: "LNK-002",
  version: 1,
  confidence: "verified",
  impact: 2,
  needs: ["graph"],
  evaluate({ page: p, crawl, site: s }) {
    if (!isHtml200(p)) return [];
    const via = internalTargets(p, crawl.origin)
      .map((t) => s.byUrl.get(t))
      .filter((t): t is UrlFacts => !!t && t.state === "redirected");
    if (!via.length) return [];
    return [finding(LNK002, p.url, `Links to ${via.length} internal URL(s) that redirect.`, { count: via.length, targets: via.slice(0, EVIDENCE_CAP).map((t) => ({ url: t.url, status: t.statusCode, to: t.redirectTarget })) })];
  },
  explain: {
    why: "Every redirect hop costs crawl budget and a little link equity, and slows the click for users.",
    fix: "Update the link to point straight at the final URL.",
    acceptance: "No internal link on the page points at a redirecting URL.",
  },
});

const LNK003 = site({
  id: "LNK-003",
  version: 1,
  confidence: "heuristic",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s, crawl }) {
    const home = homeUrl(crawl.origin);
    const out: Finding[] = [];
    for (const u of s.urls) {
      if (u.url === home || !isIndexable(u) || !inSitemap(u.discoveredVia) || u.inbound > 0) continue;
      const msg = "In the sitemap, but no crawled page links to it.";
      out.push(
        crawl.complete
          ? finding(LNK003, u.url, msg, { inbound: 0 })
          : inconclusive(LNK003, u.url, "partial_crawl", `${msg} The crawl did not reach every URL, so a link may exist on a page it did not fetch.`, { inbound: 0 }),
      );
    }
    return out;
  },
  explain: {
    why: "Pages with no internal links are hard for search engines to discover and rank, and get no link equity.",
    fix: "Link to the page from a relevant section or hub page, or remove it from the sitemap if it should not exist.",
    acceptance: "At least one crawlable internal link points to the page.",
  },
});

const LNK004 = site({
  id: "LNK-004",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["graph"],
  evaluate({ site: s }) {
    return s.urls
      .filter((u) => isIndexable(u) && u.linkDepth !== null && u.linkDepth > MAX_CLICK_DEPTH)
      .map((u) => finding(LNK004, u.url, `${u.linkDepth} clicks from the start page (more than ${MAX_CLICK_DEPTH}).`, { depth: u.linkDepth }));
  },
  explain: {
    why: "Deeply buried pages are crawled less often and are treated as less important.",
    fix: "Link to the page from higher in the structure: a hub, category page or navigation.",
    acceptance: `The page is ${MAX_CLICK_DEPTH} clicks or fewer from the start page.`,
  },
});

const LNK005 = site({
  id: "LNK-005",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["graph"],
  evaluate({ site: s, crawl }) {
    const home = homeUrl(crawl.origin);
    const out: Finding[] = [];
    for (const u of s.urls) {
      if (u.url === home || !isIndexable(u) || u.inbound !== 1) continue;
      const msg = "Only one crawled page links to it.";
      out.push(crawl.complete ? finding(LNK005, u.url, msg, { inbound: 1 }) : inconclusive(LNK005, u.url, "partial_crawl", `${msg} The crawl did not reach every URL, so more links may exist.`, { inbound: 1 }));
    }
    return out;
  },
  explain: {
    why: "A single inbound link makes a page fragile to discover and signals low importance.",
    fix: "Add contextual links from related pages.",
    acceptance: "At least two crawled pages link to it.",
  },
});

const LNK006 = page({
  id: "LNK-006",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p, crawl }) {
    if (!isHtml200(p)) return [];
    const nf = [...new Set(anchors(p).filter((l) => l.nofollow && isInternal(l.href, crawl.origin)).map((l) => l.href))];
    return nf.length ? [finding(LNK006, p.url, `${nf.length} internal link(s) carry rel="nofollow".`, { count: nf.length, targets: nf.slice(0, EVIDENCE_CAP) })] : [];
  },
  explain: {
    why: "nofollow on internal links stops link equity from flowing to your own pages.",
    fix: 'Remove rel="nofollow" from internal links; use robots meta or authentication for pages you want to keep out.',
    acceptance: "No internal link on the page has rel=nofollow.",
  },
});

/** Anchor texts that say nothing about the target. Compared lower-cased, without trailing punctuation. */
export const GENERIC_ANCHORS = new Set(["click here", "here", "click", "read more", "more", "learn more", "this link", "link", "this page", "go", "continue", "details", "more info"]);

const LNK007 = page({
  id: "LNK-007",
  version: 1,
  confidence: "heuristic",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const bad = anchors(p).filter((l) => {
      const a = (l.anchor ?? "").trim().toLowerCase().replace(/[.!…›»>→:]+$/u, "").trim();
      return !a || GENERIC_ANCHORS.has(a);
    });
    if (!bad.length) return [];
    return [finding(LNK007, p.url, `${bad.length} link(s) with empty or generic anchor text.`, { count: bad.length, links: bad.slice(0, EVIDENCE_CAP).map((l) => ({ href: l.href, anchor: l.anchor ?? "" })) })];
  },
  explain: {
    why: "Anchor text tells users and search engines what the target is about; empty or generic text wastes that signal.",
    fix: 'Use descriptive text ("pricing for the Pro plan"), or an aria-label or image alt for icon links.',
    acceptance: "Every link has descriptive text, aria-label or image alt.",
  },
});

const LNK008 = page({
  id: "LNK-008",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const n = anchors(p).length;
    return n > MAX_LINKS ? [finding(LNK008, p.url, `${n} links on the page (over ${MAX_LINKS}).`, { count: n, threshold: MAX_LINKS })] : [];
  },
  explain: {
    why: "Very long link lists dilute each link's weight and can signal low-quality, auto-generated pages.",
    fix: "Trim navigation and footer links, paginate long lists, or group them on hub pages.",
    acceptance: `${MAX_LINKS} links or fewer.`,
  },
});

/** LNK-010: these responses prove an external URL is gone; anything else that is not 2xx/3xx is ambiguous. */
const BROKEN_STATUS = new Set([404, 410]);

export const LNK010: ResourceRule = {
  id: "LNK-010",
  version: 1,
  scope: "resource",
  kind: "external_link",
  category: "links",
  confidence: "verified",
  impact: 1,
  needs: ["headers"],
  evaluate({ resource: r }) {
    if (r.state !== "done") return [];
    const ev = { status: r.status, method: r.method, error: r.error?.code ?? null, linkedFrom: r.referrers, pages: r.samplePages };
    if ((r.status !== null && BROKEN_STATUS.has(r.status)) || r.error?.code === "DNS_FAILED") {
      return [finding(LNK010, r.url, `External link target ${r.status !== null ? `returns HTTP ${r.status}` : "does not resolve (DNS)"}; linked from ${r.referrers} page(s).`, ev)];
    }
    if ((r.status !== null && (r.status === 403 || r.status === 429 || r.status === 999 || r.status >= 500)) || (r.error && r.status === null)) {
      const what = r.status !== null ? `HTTP ${r.status}` : r.error!.message;
      return [inconclusive(LNK010, r.url, "ambiguous_status", `External link target answered ${what}, which does not prove it is broken (bot blocking, rate limiting or a temporary error).`, ev)];
    }
    return [];
  },
  explain: {
    why: "Links to dead external pages frustrate users and look neglected.",
    fix: "Update the link to the page's new address, link to an alternative, or remove it.",
    acceptance: "The target returns 2xx (or redirects to a 2xx page).",
  },
};

const LNK011 = page({
  id: "LNK-011",
  version: 1,
  confidence: "verified",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p, crawl }) {
    if (!isHtml200(p) || !p.finalUrl.startsWith("https:")) return [];
    const http = [...new Set(anchors(p).filter((l) => l.href.startsWith("http:") && isInternal(l.href, crawl.origin)).map((l) => l.href))];
    return http.length ? [finding(LNK011, p.url, `${http.length} internal link(s) use http on an https page.`, { count: http.length, targets: http.slice(0, EVIDENCE_CAP) })] : [];
  },
  explain: {
    why: "http links to your own https site cost a redirect each and can leak users onto an insecure connection.",
    fix: "Change the links to https (or to root-relative paths).",
    acceptance: "No internal link on an https page uses http.",
  },
});

const LNK012 = site({
  id: "LNK-012",
  version: 1,
  confidence: "heuristic",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s, crawl }) {
    // "High-value" is a business judgement: the user names those pages in the keyPages setting.
    if (!crawl.keyPages) throw new NeedsConfig("keyPages");
    const ranks = s.urls.filter((u) => isIndexable(u) && u.pagerank !== null).map((u) => u.pagerank!).sort((a, b) => a - b);
    if (!ranks.length) return [];
    const median = ranks[Math.floor((ranks.length - 1) / 2)];
    const out: Finding[] = [];
    for (const k of crawl.keyPages) {
      const u = s.byUrl.get(k);
      if (!u || !isIndexable(u) || u.pagerank === null || u.pagerank >= median) continue;
      out.push(finding(LNK012, u.url, `Key page with internal PageRank ${u.pagerank.toFixed(1)}, below the median indexable page (${median.toFixed(1)}).`, { pagerank: u.pagerank, median, inbound: u.inbound }));
    }
    return out;
  },
  explain: {
    why: "Pages you care most about should receive the most internal link equity; a key page below the median is under-linked.",
    fix: "Link to it from the home page, navigation and strong hub pages.",
    acceptance: "The key page's internal PageRank is at or above the median indexable page.",
  },
});

const LNK013 = page({
  id: "LNK-013",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const linked = new Set(anchors(p).map((l) => l.href));
    const next = p.links.filter((l) => l.via === "pagination" && /\bnext\b/i.test(l.rel) && !linked.has(l.href)).map((l) => l.href);
    return next.length ? [finding(LNK013, p.url, 'rel="next" names a page no <a href> on this page links to.', { next: [...new Set(next)] })] : [];
  },
  explain: {
    why: 'Google ignores rel="next"; paginated pages are found only through ordinary links.',
    fix: "Add a plain <a href> to the next page (and to numbered pages).",
    acceptance: "The next page is linked with an <a href>.",
  },
});

const LNK014 = site({
  id: "LNK-014",
  version: 2,
  confidence: "heuristic",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s, crawl }) {
    const byPath = new Map<string, { count: number; params: Set<string>; sample: string[] }>();
    for (const u of s.urls) {
      const url = new URL(u.url);
      // The site's own URLs only: query strings on another host (wa.me?text=…) are not this site's crawl trap.
      if (!url.search || !isInternal(u.url, crawl.origin)) continue;
      const base = `${url.origin}${url.pathname}`;
      const g = byPath.get(base) ?? { count: 0, params: new Set<string>(), sample: [] };
      g.count++;
      for (const k of url.searchParams.keys()) g.params.add(k);
      if (g.sample.length < 5) g.sample.push(u.url);
      byPath.set(base, g);
    }
    const out: Finding[] = [];
    for (const [base, g] of byPath) {
      if (g.count <= FACET_TRAP_COMBOS) continue;
      out.push(finding(LNK014, base, `${g.count} distinct query-string URLs found under this path (parameters: ${[...g.params].join(", ")}).`, { count: g.count, threshold: FACET_TRAP_COMBOS, params: [...g.params], sample: g.sample }));
    }
    return out;
  },
  explain: {
    why: "Facet and sort parameters multiply into near-endless URL combinations that eat crawl budget and duplicate content.",
    fix: "Link facets with a crawl-safe pattern (no <a href> for combinations, or one canonical per category), and disallow unbounded combinations in robots.txt.",
    acceptance: `${FACET_TRAP_COMBOS} or fewer crawlable query variants per path.`,
  },
});

export const LNK_RULES = [LNK001, LNK002, LNK003, LNK004, LNK005, LNK006, LNK007, LNK008, LNK010, LNK011, LNK012, LNK013, LNK014];
