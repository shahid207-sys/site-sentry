// Crawlability and indexability rules (docs/SPEC.md catalog, IDX). IDX-018 (canonical raw vs rendered) reads the
// render and lives in rendered.ts.
import { parseRobotsHeader } from "../snapshot/extract";
import { finding, inconclusive, inSitemap, isIndexable, type Finding, type PageRule, type SiteRule, type UrlFacts } from "./contract";
import { skippedByRobots } from "./probe-types";
import { generalDirectives, homeUrl, isHtml200, robotsUrl } from "./util";

const page = (r: Omit<PageRule, "scope" | "category">): PageRule => ({ scope: "page", category: "indexability", ...r });
const site = (r: Omit<SiteRule, "scope" | "category">): SiteRule => ({ scope: "site", category: "indexability", ...r });

// ---------- status and redirects ----------

const IDX001 = page({
  id: "IDX-001",
  version: 1,
  confidence: "verified",
  impact: 5,
  needs: ["headers"],
  evaluate({ page: p }) {
    return p.statusCode >= 400 && p.statusCode < 500 ? [finding(IDX001, p.url, `Internal URL returns HTTP ${p.statusCode}.`, { status: p.statusCode, discoveredVia: p.discoveredVia })] : [];
  },
  explain: {
    why: "Internal URLs that return a client error waste crawl budget and break the paths users and crawlers follow.",
    fix: "Restore the page, or redirect the URL to its replacement and update the links that point to it.",
    acceptance: "The URL returns 200, or a single 301 to a 200 page.",
  },
});

const IDX002 = page({
  id: "IDX-002",
  version: 1,
  confidence: "verified",
  impact: 5,
  needs: ["headers"],
  evaluate({ page: p }) {
    return p.statusCode >= 500 && p.statusCode < 600 ? [finding(IDX002, p.url, `Internal URL returns HTTP ${p.statusCode}.`, { status: p.statusCode })] : [];
  },
  explain: {
    why: "Server errors tell search engines the page is unavailable; persistent 5xx responses get pages dropped from the index.",
    fix: "Find the server-side cause (logs for this URL) and fix it.",
    acceptance: "The URL returns 200 on repeated requests.",
  },
});

/** Follow redirect rows from `start`: the hops in order, and whether the walk ended in a loop. */
export function walkRedirects(start: UrlFacts, byUrl: Map<string, UrlFacts>): { hops: UrlFacts[]; loop: boolean; end: UrlFacts | null } {
  const hops: UrlFacts[] = [];
  const seen = new Set<string>();
  let at: UrlFacts | undefined = start;
  while (at && at.state === "redirected" && at.redirectTarget) {
    if (seen.has(at.url)) return { hops, loop: true, end: null };
    seen.add(at.url);
    hops.push(at);
    at = byUrl.get(at.redirectTarget);
  }
  return { hops, loop: false, end: at ?? null };
}

const IDX003 = site({
  id: "IDX-003",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const u of s.urls) {
      if (u.state !== "redirected") continue;
      const w = walkRedirects(u, s.byUrl);
      if (w.loop || w.hops.length < 3) continue;
      out.push(finding(IDX003, u.url, `Redirect chain of ${w.hops.length} hops before a final response.`, { hops: w.hops.length, chain: [...w.hops.map((h) => `${h.statusCode} ${h.url}`), w.end?.url ?? w.hops[w.hops.length - 1].redirectTarget] }));
    }
    return out;
  },
  explain: {
    why: "Each hop costs a request and some link equity; crawlers stop following long chains.",
    fix: "Point the first URL (and every link to it) straight at the final destination.",
    acceptance: "The URL reaches its final 200 page in at most one redirect.",
  },
});

const IDX004 = site({
  id: "IDX-004",
  version: 1,
  confidence: "verified",
  impact: 5,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const u of s.urls) {
      if (u.state !== "redirected") continue;
      // u is in a loop when following its redirects comes back to u itself.
      const cycle: string[] = [u.url];
      let at = u.redirectTarget ? s.byUrl.get(u.redirectTarget) : undefined;
      while (at && at.state === "redirected" && at.redirectTarget && at.url !== u.url && cycle.length <= 20) {
        cycle.push(at.url);
        at = s.byUrl.get(at.redirectTarget);
      }
      if (at?.url === u.url) out.push(finding(IDX004, u.url, `Redirect loop through ${cycle.length} URL(s).`, { loop: cycle }));
    }
    return out;
  },
  explain: {
    why: "A redirect loop never reaches a page: users see an error and the URL cannot be indexed.",
    fix: "Break the loop by redirecting to the intended final page, or serve the page with 200.",
    acceptance: "Following the URL's redirects ends at a 200 page.",
  },
});

const IDX005 = site({
  id: "IDX-005",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const u of s.urls) {
      if (u.state !== "redirected" || (u.statusCode !== 302 && u.statusCode !== 307)) continue;
      const w = walkRedirects(u, s.byUrl);
      if (w.loop || w.end?.statusCode !== 200) continue; // only redirects that settle on a live page look like moves
      out.push(finding(IDX005, u.url, `HTTP ${u.statusCode} (temporary) to a live page; if the move is permanent, use 301 or 308.`, { status: u.statusCode, target: u.redirectTarget, final: w.end.url }));
    }
    return out;
  },
  explain: {
    why: "Search engines keep the old URL indexed for a temporary redirect; a permanent move should consolidate on the new URL.",
    fix: "If the content has moved for good, change the redirect to 301 (or 308).",
    acceptance: "The redirect returns 301/308, or the move is confirmed as temporary.",
  },
});

const IDX006 = page({
  id: "IDX-006",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || !p.facts) return [];
    if (p.facts.metaRefresh?.target) return [finding(IDX006, p.url, "Meta-refresh redirect.", { kind: "meta", content: p.facts.metaRefresh.content, target: p.facts.metaRefresh.target })];
    if (p.facts.jsRedirect) return [finding(IDX006, p.url, "JavaScript redirect.", { kind: "js", target: p.facts.jsRedirect })];
    return [];
  },
  explain: {
    why: "Client-side redirects are slower, not always followed, and pass signals less reliably than an HTTP redirect.",
    fix: "Replace the meta refresh or script with an HTTP 301 from the server.",
    acceptance: "The URL answers with a 301/308 to the target and no client-side redirect remains.",
  },
});

// ---------- robots directives ----------

const IDX007 = site({
  id: "IDX-007",
  version: 1,
  confidence: "verified",
  impact: 4,
  needs: ["graph"],
  evaluate({ site: s }) {
    return s.urls.filter((u) => u.state === "blocked_robots" && inSitemap(u.discoveredVia)).map((u) => finding(IDX007, u.url, "Listed in the sitemap but blocked by robots.txt.", { discoveredVia: u.discoveredVia }));
  },
  explain: {
    why: "A sitemap asks search engines to index the URL while robots.txt forbids crawling it; the page cannot be read or properly indexed.",
    fix: "Either allow the URL in robots.txt, or remove it from the sitemap if it should stay private.",
    acceptance: "The URL is either crawlable or absent from every sitemap.",
  },
});

const IDX008 = page({
  id: "IDX-008",
  version: 1,
  confidence: "verified",
  impact: 4,
  needs: ["raw"],
  evaluate({ page: p }) {
    return p.html && p.robots?.noindex.meta && inSitemap(p.discoveredVia) ? [finding(IDX008, p.url, "Meta robots noindex on a URL listed in the sitemap.", { meta: generalDirectives(p, "meta") })] : [];
  },
  explain: {
    why: "The sitemap asks for indexing while the page asks not to be indexed: a contradiction search engines resolve by dropping the page.",
    fix: "Remove the noindex if the page should rank, or remove the URL from the sitemap.",
    acceptance: "No sitemap URL carries meta noindex.",
  },
});

const IDX009 = page({
  id: "IDX-009",
  version: 1,
  confidence: "verified",
  impact: 4,
  needs: ["headers"],
  evaluate({ page: p }) {
    const header = p.headers["x-robots-tag"];
    if (!header) return [];
    const general = parseRobotsHeader(header).filter((d) => d.agent === "*").flatMap((d) => d.directives);
    return general.includes("noindex") || general.includes("none") ? [finding(IDX009, p.url, "X-Robots-Tag header says noindex.", { header })] : [];
  },
  explain: {
    why: "A noindex sent in the HTTP header is invisible in the page source and easy to ship by accident, e.g. from a staging config.",
    fix: "Remove the header for URLs that should be indexed.",
    acceptance: "The response has no X-Robots-Tag noindex, or the page is confirmed as not for indexing.",
  },
});

const opposite: Record<string, string[]> = { noindex: ["index", "all"], nofollow: ["follow", "all"], none: ["index", "follow", "all"] };
const IDX010 = page({
  id: "IDX-010",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["raw", "headers"],
  evaluate({ page: p }) {
    if (!p.html) return [];
    const meta = generalDirectives(p, "meta");
    const header = generalDirectives(p, "header");
    const conflicts: string[] = [];
    for (const [d, opp] of Object.entries(opposite)) {
      if (meta.includes(d) && opp.some((o) => header.includes(o))) conflicts.push(`meta ${d} vs header ${opp.filter((o) => header.includes(o)).join(",")}`);
      if (header.includes(d) && opp.some((o) => meta.includes(o))) conflicts.push(`header ${d} vs meta ${opp.filter((o) => meta.includes(o)).join(",")}`);
    }
    return conflicts.length ? [finding(IDX010, p.url, "Meta robots and X-Robots-Tag disagree.", { meta, header, conflicts })] : [];
  },
  explain: {
    why: "When directives conflict, search engines apply the most restrictive one, which is rarely what both authors intended.",
    fix: "Decide the intended directive and set it in one place.",
    acceptance: "Meta robots and X-Robots-Tag no longer contradict each other.",
  },
});

// ---------- canonicals ----------

const linkCanonicals = (p: { canonicals: { location: string }[] }) => p.canonicals.filter((c) => c.location !== "header");

const IDX011 = page({
  id: "IDX-011",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw", "headers"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || p.robots?.noindex.meta || p.robots?.noindex.header || p.canonicals.length) return [];
    return [finding(IDX011, p.url, "Indexable page has no canonical.")];
  },
  explain: {
    why: "Without a canonical, search engines pick one among URL variants (parameters, slashes, case) themselves.",
    fix: 'Add <link rel="canonical" href="(absolute URL of this page)"> in <head>.',
    acceptance: "The page declares an absolute canonical in <head> or the Link header.",
  },
});

/** Pages whose effective canonical points at another crawled URL, with that URL's row. */
function canonicalTargets(urls: UrlFacts[], byUrl: Map<string, UrlFacts>) {
  const out: { from: UrlFacts; to: UrlFacts | undefined; canonical: string }[] = [];
  for (const u of urls) {
    const c = u.page?.canonical;
    if (u.statusCode !== 200 || !c || c === u.url) continue;
    out.push({ from: u, to: byUrl.get(c), canonical: c });
  }
  return out;
}

const IDX012 = site({
  id: "IDX-012",
  version: 1,
  confidence: "verified",
  impact: 4,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const { from, to, canonical } of canonicalTargets(s.urls, s.byUrl)) {
      // A target that was never fetched (blocked, out of scope, budget) is inconclusive, not a finding.
      if (!to || to.statusCode === null || to.statusCode === 200) continue;
      out.push(finding(IDX012, from.url, `Canonical points to a URL that returns HTTP ${to.statusCode}.`, { canonical, targetStatus: to.statusCode, targetState: to.state }));
    }
    return out;
  },
  explain: {
    why: "A canonical must name a live page; pointing at an error or redirect makes search engines ignore it.",
    fix: "Point the canonical at the final 200 URL of the preferred page.",
    acceptance: "The canonical target returns 200.",
  },
});

const IDX013 = site({
  id: "IDX-013",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const { from, to, canonical } of canonicalTargets(s.urls, s.byUrl)) {
      const next = to?.statusCode === 200 ? to.page?.canonical : null;
      if (!next || next === to!.url) continue;
      out.push(finding(IDX013, from.url, "Canonical points to a page that is itself canonicalised elsewhere.", { chain: [from.url, canonical, next] }));
    }
    return out;
  },
  explain: {
    why: "Canonical chains are often not followed; the signal may be ignored.",
    fix: "Point every canonical directly at the final preferred URL.",
    acceptance: "The canonical target is self-canonical.",
  },
});

const IDX014 = site({
  id: "IDX-014",
  version: 1,
  confidence: "verified",
  impact: 4,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const { from, to, canonical } of canonicalTargets(s.urls, s.byUrl)) {
      if (to?.state === "blocked_robots") out.push(finding(IDX014, from.url, "Canonical points to a URL blocked by robots.txt.", { canonical, target: "blocked_robots" }));
      else if (to?.statusCode === 200 && to.page?.noindex) out.push(finding(IDX014, from.url, "Canonical points to a noindexed page.", { canonical, target: "noindex" }));
    }
    return out;
  },
  explain: {
    why: "Search engines cannot index a noindexed or uncrawlable canonical target, so neither page may be indexed.",
    fix: "Point the canonical at an indexable, crawlable page, or remove the noindex / robots block from the target.",
    acceptance: "The canonical target is crawlable and has no noindex.",
  },
});

const IDX015 = page({
  id: "IDX-015",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p }) {
    const tags = linkCanonicals(p);
    return tags.length > 1 ? [finding(IDX015, p.url, `${tags.length} canonical tags.`, { canonicals: tags })] : [];
  },
  explain: {
    why: "With more than one canonical, search engines may ignore all of them.",
    fix: "Keep exactly one canonical in <head>; check the CMS theme and SEO plugins for a second one.",
    acceptance: "Exactly one canonical tag.",
  },
});

const IDX016 = page({
  id: "IDX-016",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p }) {
    const body = p.canonicals.filter((c) => c.location === "body");
    return body.length ? [finding(IDX016, p.url, "Canonical tag outside <head>; search engines ignore it.", { canonicals: body })] : [];
  },
  explain: {
    why: "A canonical outside <head> (written in the body, or pushed there by invalid head markup) is ignored.",
    fix: "Move the canonical into <head>, before any element that is not allowed in <head>.",
    acceptance: "The canonical is in <head>.",
  },
});

const IDX017 = page({
  id: "IDX-017",
  version: 1,
  confidence: "verified",
  impact: 2,
  needs: ["raw", "headers"],
  evaluate({ page: p }) {
    const bad = p.canonicals.filter((c) => !c.absolute || !c.resolved);
    return bad.length ? [finding(IDX017, p.url, bad.some((c) => !c.resolved) ? "Malformed canonical URL." : "Relative canonical URL.", { canonicals: bad })] : [];
  },
  explain: {
    why: "Relative canonicals resolve differently on every URL variant, and malformed ones are ignored.",
    fix: "Use an absolute https URL in every canonical.",
    acceptance: "Every canonical is an absolute, valid http(s) URL.",
  },
});

const SOFT404 = /\b404\b|\bnot found\b|page (?:does not|doesn['’]t) exist|no longer available/i;
const IDX019 = page({
  id: "IDX-019",
  version: 1,
  confidence: "heuristic",
  impact: 4,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const h1 = p.outline.find((h) => h.level === 1)?.text ?? "";
    const hit = [p.titles[0] ?? "", h1].find((t) => SOFT404.test(t));
    return hit ? [finding(IDX019, p.url, "Returns 200 but the page says it was not found (soft 404).", { matched: hit, words: p.wordCount })] : [];
  },
  explain: {
    why: "A missing page served with 200 gets crawled and possibly indexed as an empty page.",
    fix: "Serve missing pages with 404 (or 410).",
    acceptance: "The URL returns 404/410, or shows real content.",
  },
});

// ---------- duplicate hosts and URL variants ----------

function hostVariantRule(id: "IDX-020" | "IDX-021", kind: "home_scheme" | "home_www", what: string): SiteRule {
  const rule: SiteRule = site({
    id,
    version: 2,
    confidence: "verified",
    impact: 3,
    needs: ["headers"],
    evaluate({ site: s, crawl }) {
      const home = s.byUrl.get(homeUrl(crawl.origin));
      const probe = crawl.probes.find((p) => p.kind === kind);
      if (skippedByRobots(probe) && home?.statusCode === 200) return [inconclusive(rule, home.url, "probe_skipped_robots", `${what}: ${probe.url} not checked: ${probe.skipped}.`, { variant: probe.url })];
      if (!probe || home?.statusCode !== 200 || probe.status !== 200) return [];
      return [finding(rule, home.url, `Both ${home.url} and ${probe.url} return 200 (${what}).`, { variant: probe.url, status: probe.status })];
    },
    explain: {
      why: `Two hosts serving the same site split links and duplicate every page (${what}).`,
      fix: "Redirect the variant to the preferred version with a 301, site-wide.",
      acceptance: "The variant answers with a 301 to the preferred host.",
    },
  });
  return rule;
}
const IDX020 = hostVariantRule("IDX-020", "home_scheme", "http and https");
const IDX021 = hostVariantRule("IDX-021", "home_www", "www and non-www");

const isPage200 = (u: UrlFacts | undefined): u is UrlFacts => !!u && u.statusCode === 200 && !!u.page;

const IDX022 = site({
  id: "IDX-022",
  version: 1,
  confidence: "verified",
  impact: 2,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const u of s.urls) {
      if (!isPage200(u)) continue;
      const url = new URL(u.url);
      if (url.pathname === "/" || !url.pathname.endsWith("/")) continue;
      url.pathname = url.pathname.slice(0, -1);
      const v = s.byUrl.get(url.toString());
      if (!isPage200(v)) continue;
      for (const [a, b] of [[u, v], [v, u]]) out.push(finding(IDX022, a.url, "Trailing-slash and non-slash versions both return 200.", { variant: b.url }));
    }
    return out;
  },
  explain: {
    why: "Two URLs for one page split signals and duplicate content.",
    fix: "301 one form to the other site-wide, and link to the preferred form.",
    acceptance: "Only one of the two forms returns 200.",
  },
});

const IDX023 = site({
  id: "IDX-023",
  version: 1,
  confidence: "heuristic",
  impact: 1,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const u of s.urls) {
      if (!isPage200(u)) continue;
      const url = new URL(u.url);
      const lower = url.pathname.toLowerCase();
      if (lower === url.pathname) continue;
      url.pathname = lower;
      const v = s.byUrl.get(url.toString());
      if (isPage200(v)) out.push(finding(IDX023, u.url, "Uppercase URL variant returns 200 alongside the lowercase URL.", { lowercase: v.url }));
    }
    return out;
  },
  explain: {
    why: "Case variants that resolve create duplicate URLs for the same page.",
    fix: "301 uppercase variants to the lowercase URL, and fix links that use them.",
    acceptance: "The uppercase variant redirects or returns 404.",
  },
});

const IDX024 = page({
  id: "IDX-024",
  version: 1,
  confidence: "heuristic",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || !new URL(p.url).search || p.robots?.noindex.meta || p.robots?.noindex.header || p.canonicals.length) return [];
    return [finding(IDX024, p.url, "Parameter URL is indexable and has no canonical.", { query: new URL(p.url).search })];
  },
  explain: {
    why: "Parameter variants without a canonical can be indexed as duplicates of the clean URL.",
    fix: "Add a canonical to the parameter-free URL, or noindex the variants.",
    acceptance: "The parameter URL declares a canonical or a noindex.",
  },
});

// ---------- robots.txt and sitemaps ----------

const IDX025 = site({
  id: "IDX-025",
  version: 1,
  confidence: "verified",
  impact: 5,
  needs: ["headers"],
  evaluate({ crawl }) {
    const r = crawl.robots;
    if (!r) return [];
    const unreachable = r.status === null ? !!r.error : r.status >= 500;
    if (!unreachable) return [];
    return [finding(IDX025, robotsUrl(crawl.origin), r.error ? `robots.txt could not be fetched: ${r.error.message}` : `robots.txt returns HTTP ${r.status}.`, { status: r.status, error: r.error ?? null, outcome: r.outcome })];
  },
  explain: {
    why: "Search engines treat an unreachable or 5xx robots.txt as a full disallow and may stop crawling the site.",
    fix: "Serve robots.txt with 200 (or 404 if there are no rules).",
    acceptance: "robots.txt returns 200 or 404.",
  },
});

const IDX026 = page({
  id: "IDX-026",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p, crawl }) {
    if (!isHtml200(p) || !p.facts) return [];
    const host = new URL(crawl.origin).host;
    const blocked = p.facts.renderResources.filter((r) => new URL(r).host === host && crawl.robotsAllows(r, "Googlebot") === false);
    return blocked.length ? [finding(IDX026, p.url, `${blocked.length} stylesheet/script URL(s) the page loads are blocked by robots.txt.`, { blocked: blocked.slice(0, 20) })] : [];
  },
  explain: {
    why: "Search engines render pages; blocked CSS or JS can make them see a broken or empty page.",
    fix: "Allow the asset paths in robots.txt.",
    acceptance: "Every same-host stylesheet and script the page loads is allowed for Googlebot.",
  },
});

const readSitemaps = (docs: { status: number | null; kind: string | null; skipped?: string }[]) => docs.filter((d) => !d.skipped && d.status === 200 && (d.kind === "urlset" || d.kind === "sitemapindex"));

const IDX027 = site({
  id: "IDX-027",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["headers"],
  evaluate({ crawl }) {
    const missing = readSitemaps(crawl.sitemaps).length === 0;
    const parsed = crawl.robots?.outcome === "parsed" || crawl.robots?.outcome === "allow_all";
    const unreferenced = parsed && !(crawl.robots?.sitemaps ?? []).length;
    if (!missing && !unreferenced) return [];
    const message = missing && unreferenced ? "No sitemap found, and robots.txt references none." : missing ? "No readable sitemap found." : "robots.txt has no Sitemap: line.";
    return [finding(IDX027, robotsUrl(crawl.origin), message, { sitemapsRead: readSitemaps(crawl.sitemaps).map((d) => (d as { url?: string }).url), robotsSitemaps: crawl.robots?.sitemaps ?? [] })];
  },
  explain: {
    why: "A sitemap referenced from robots.txt is the most reliable way for every search engine to find all your URLs.",
    fix: "Publish an XML sitemap and add a Sitemap: line for it to robots.txt.",
    acceptance: "robots.txt names a sitemap that returns 200 and parses.",
  },
});

const IDX028 = site({
  id: "IDX-028",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s }) {
    return s.urls
      .filter((u) => inSitemap(u.discoveredVia) && u.statusCode !== null && u.statusCode !== 200)
      .map((u) => finding(IDX028, u.url, `Sitemap lists a URL that returns HTTP ${u.statusCode}.`, { status: u.statusCode, redirectTarget: u.redirectTarget }));
  },
  explain: {
    why: "Sitemaps should list only final, live URLs; errors and redirects waste crawls and erode trust in the sitemap.",
    fix: "List the final 200 URL instead, or remove the entry.",
    acceptance: "Every sitemap URL returns 200.",
  },
});

const IDX029 = site({
  id: "IDX-029",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const u of s.urls) {
      if (!inSitemap(u.discoveredVia) || u.statusCode !== 200 || !u.page) continue;
      if (u.page.noindex) out.push(finding(IDX029, u.url, "Sitemap lists a noindexed URL.", { reason: "noindex" }));
      else if (u.page.canonical && u.page.canonical !== u.url) out.push(finding(IDX029, u.url, "Sitemap lists a URL canonicalised to another URL.", { reason: "canonicalised", canonical: u.page.canonical }));
    }
    return out;
  },
  explain: {
    why: "A sitemap is a list of URLs you want indexed; noindexed or canonicalised entries send mixed signals.",
    fix: "Remove the URL from the sitemap, or make it indexable and self-canonical.",
    acceptance: "Every sitemap URL is indexable and self-canonical.",
  },
});

const IDX030 = site({
  id: "IDX-030",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["headers"],
  evaluate({ crawl }) {
    return crawl.sitemaps
      .filter((d) => !d.skipped && d.truncated)
      .map((d) => finding(IDX030, d.url, "Sitemap is over the protocol limit of 50,000 URLs or 50 MB; entries past the limit were not read.", { urlsRead: d.urlCount }));
  },
  explain: {
    why: "Search engines stop reading a sitemap at 50,000 URLs or 50 MB uncompressed.",
    fix: "Split it into several sitemaps under a sitemap index.",
    acceptance: "Every sitemap is within 50,000 URLs and 50 MB.",
  },
});

const DAY = 86_400_000;
const IDX031 = site({
  id: "IDX-031",
  version: 1,
  confidence: "heuristic",
  impact: 1,
  needs: ["headers"],
  evaluate({ crawl }) {
    const out: Finding[] = [];
    const now = Date.parse(crawl.startedAt);
    for (const d of crawl.sitemaps) {
      const l = d.lastmod;
      if (!l || !l.count) continue;
      // A day of slack: a date-only lastmod for "today" in another time zone is not in the future.
      if (l.max && Date.parse(l.max) > now + DAY) out.push(finding(IDX031, d.url, `lastmod in the future (${l.max}).`, { reason: "future", max: l.max }));
      else if (l.count === d.urlCount && d.urlCount >= 2 && l.distinct === 1) out.push(finding(IDX031, d.url, `All ${l.count} URLs have the same lastmod (${l.max}).`, { reason: "identical", value: l.max }));
    }
    return out;
  },
  explain: {
    why: "Search engines ignore lastmod that is clearly not maintained, losing a cheap freshness signal.",
    fix: "Write each URL's real last significant change date, or leave lastmod out.",
    acceptance: "No lastmod is in the future and the values differ where pages changed at different times.",
  },
});

const IDX032 = site({
  id: "IDX-032",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["graph"],
  evaluate({ site: s, crawl }) {
    if (!readSitemaps(crawl.sitemaps).some((d) => d.kind === "urlset")) return []; // no sitemap at all: IDX-027
    return s.urls.filter((u) => isIndexable(u) && !inSitemap(u.discoveredVia)).map((u) => finding(IDX032, u.url, "Indexable page missing from every sitemap.", { discoveredVia: u.discoveredVia }));
  },
  explain: {
    why: "Pages left out of the sitemap are found later, or not at all if few links point to them.",
    fix: "Add the URL to the sitemap, or make it non-indexable if it should not rank.",
    acceptance: "The URL is listed in a sitemap.",
  },
});

export const IDX_RULES = [
  IDX001, IDX002, IDX003, IDX004, IDX005, IDX006, IDX007, IDX008, IDX009, IDX010, IDX011, IDX012, IDX013, IDX014, IDX015, IDX016, IDX017, IDX019,
  IDX020, IDX021, IDX022, IDX023, IDX024, IDX025, IDX026, IDX027, IDX028, IDX029, IDX030, IDX031, IDX032,
];
