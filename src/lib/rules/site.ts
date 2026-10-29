// Site-level rules (docs/SPEC.md catalog, SITE) over the whole crawl. SITE-004 and SITE-005 compare against an
// earlier audit (Phase 3 history) and are not implemented.
import { finding, inSitemap, isIndexable, type Finding, type SiteRule, type UrlFacts } from "./contract";
import { homeUrl } from "./util";

const site = (r: Omit<SiteRule, "scope" | "category">): SiteRule => ({ scope: "site", category: "site", ...r });

/** Spec: an issue shared by 90%+ of a template group. */
export const TEMPLATE_SHARE = 0.9;
/** A template group needs this many pages before a shared issue counts as the template's. */
export const MIN_TEMPLATE_PAGES = 5;
/** Spec: indexable page ratio below 50%. */
export const MIN_INDEXABLE_RATIO = 0.5;
const SAMPLE = 10;

const SITE001 = site({
  id: "SITE-001",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s, pageIssues }) {
    const groups = new Map<string, number>();
    for (const u of s.urls) if (u.page?.template) groups.set(u.page.template, (groups.get(u.page.template) ?? 0) + 1);
    const out: Finding[] = [];
    for (const [ruleId, byTemplate] of pageIssues) {
      for (const [template, t] of byTemplate) {
        const size = groups.get(template) ?? 0;
        if (size < MIN_TEMPLATE_PAGES || t.count < TEMPLATE_SHARE * size) continue;
        out.push(
          finding(SITE001, t.sample[0], `${ruleId} affects ${t.count} of ${size} pages built from one template: fix it once in the template.`, {
            ruleId,
            template,
            pages: t.count,
            groupSize: size,
            share: Math.round((t.count / size) * 1000) / 1000,
            sample: t.sample,
          }),
        );
      }
    }
    return out;
  },
  explain: {
    why: "A defect on nearly every page of a template comes from the template itself; one fix resolves them all.",
    fix: "Fix the shared template (layout, component or CMS field), not each page.",
    acceptance: `Fewer than ${TEMPLATE_SHARE * 100}% of the template's pages have the issue.`,
  },
});

/** A sitemap URL the crawl could judge: it was fetched or deliberately not (robots), not cut off by budget or failure. */
const judged = (u: UrlFacts) => u.statusCode !== null || u.state === "blocked_robots" || u.state === "redirected";

const SITE002 = site({
  id: "SITE-002",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s, crawl }) {
    const sitemap = crawl.sitemaps.find((d) => d.status === 200 && d.kind === "urlset") ?? crawl.sitemaps.find((d) => d.status === 200);
    if (!sitemap) return [];
    const listedNotIndexable: string[] = [];
    let listed = 0;
    let unjudged = 0;
    const indexableNotListed: string[] = [];
    let indexable = 0;
    for (const u of s.urls) {
      if (inSitemap(u.discoveredVia)) {
        listed++;
        if (!judged(u)) unjudged++;
        else if (!isIndexable(u)) listedNotIndexable.push(u.url);
      }
      if (isIndexable(u)) {
        indexable++;
        if (!inSitemap(u.discoveredVia)) indexableNotListed.push(u.url);
      }
    }
    if (!listedNotIndexable.length && !indexableNotListed.length) return [];
    return [
      finding(SITE002, sitemap.url, `Sitemap and crawl disagree: ${listedNotIndexable.length} listed URL(s) are not indexable pages; ${indexableNotListed.length} indexable page(s) are not listed.`, {
        listed,
        indexable,
        listedNotIndexable: listedNotIndexable.length,
        indexableNotListed: indexableNotListed.length,
        listedNotCrawled: unjudged,
        sampleListedNotIndexable: listedNotIndexable.slice(0, SAMPLE),
        sampleIndexableNotListed: indexableNotListed.slice(0, SAMPLE),
      }),
    ];
  },
  explain: {
    why: "A sitemap should list exactly the canonical, indexable pages; mismatches waste crawl budget and hide pages.",
    fix: "Generate the sitemap from the indexable pages: drop redirects, errors, noindex and canonicalised URLs, add what is missing.",
    acceptance: "Every listed URL is an indexable page and every indexable page is listed.",
  },
});

const SITE003 = site({
  id: "SITE-003",
  version: 1,
  confidence: "heuristic",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s, crawl }) {
    // Pages: HTML responses and error responses; redirects and non-HTML files are not pages.
    const pages = s.urls.filter((u) => u.state !== "redirected" && (u.page !== null || (u.statusCode !== null && u.statusCode >= 400)));
    if (!pages.length) return [];
    const indexable = pages.filter(isIndexable).length;
    const ratio = indexable / pages.length;
    if (ratio >= MIN_INDEXABLE_RATIO) return [];
    return [finding(SITE003, homeUrl(crawl.origin), `Only ${indexable} of ${pages.length} crawled pages (${Math.round(ratio * 100)}%) are indexable.`, { indexable, pages: pages.length, ratio: Math.round(ratio * 1000) / 1000, threshold: MIN_INDEXABLE_RATIO })];
  },
  explain: {
    why: "When most crawled pages are errors, noindex or duplicates, crawl budget goes to pages that can never rank.",
    fix: "Stop linking to non-indexable URLs (parameters, duplicates, errors) and fix the pages that should be indexable.",
    acceptance: `At least ${MIN_INDEXABLE_RATIO * 100}% of crawled pages are indexable.`,
  },
});

export const SITE_RULES = [SITE001, SITE002, SITE003];
