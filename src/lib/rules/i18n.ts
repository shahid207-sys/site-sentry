// International targeting rules (docs/SPEC.md catalog, I18N), from <link rel="alternate" hreflang> in the page head.
// hreflang in HTTP Link headers and in sitemaps is not read yet (see docs/PHASE-2.md). Reciprocity is checked across
// the whole crawl from the site view; a target the crawl did not fetch is never reported.
import { finding, isIndexable, type Finding, type Hreflang, type PageRule, type PageView, type SiteRule, type UrlFacts } from "./contract";
import { LANGUAGES, REGIONS, SCRIPTS } from "./data/language-codes";
import { isHtml200 } from "./util";

const page = (r: Omit<PageRule, "scope" | "category">): PageRule => ({ scope: "page", category: "international", ...r });
const site = (r: Omit<SiteRule, "scope" | "category">): SiteRule => ({ scope: "site", category: "international", ...r });

const CAP = 20;

/** hreflang annotations of a page snapshot. */
export const pageHreflang = (p: PageView): Hreflang[] => p.links.filter((l) => l.via === "hreflang" && l.hreflang).map((l) => ({ lang: l.hreflang!, href: l.href }));
const annotated = (u: UrlFacts) => (u.page?.hreflang.length ?? 0) > 0;

/**
 * Why an hreflang value is invalid, or null. Google: an ISO 639-1 language, optionally an ISO 15924 script, optionally
 * an ISO 3166-1 alpha-2 region, or "x-default". Case-insensitive. The region alone is never valid.
 */
export function hreflangProblem(value: string): string | null {
  const v = value.trim();
  if (v.toLowerCase() === "x-default") return null;
  const parts = v.split(/[-_]/);
  if (v.includes("_")) return "uses an underscore; the separator is a hyphen";
  const [lang, ...rest] = parts;
  if (!LANGUAGES.has(lang.toLowerCase())) return /^[a-z]{2}$/i.test(lang) && REGIONS.has(lang.toUpperCase()) ? `"${lang}" is a region code, not a language` : `"${lang}" is not an ISO 639-1 language code`;
  let i = 0;
  if (rest[i] && rest[i].length === 4) {
    const script = rest[i][0].toUpperCase() + rest[i].slice(1).toLowerCase();
    if (!SCRIPTS.has(script)) return `"${rest[i]}" is not an ISO 15924 script code`;
    i++;
  }
  if (rest[i] !== undefined) {
    if (!REGIONS.has(rest[i].toUpperCase())) return `"${rest[i]}" is not an ISO 3166-1 alpha-2 region code${rest[i].toUpperCase() === "UK" ? " (the United Kingdom is GB)" : ""}`;
    i++;
  }
  return rest.length > i ? `unexpected subtag "${rest[i]}"` : null;
}

const I18N001 = site({
  id: "I18N-001",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const u of s.urls) {
      if (!u.page || u.statusCode !== 200 || !annotated(u)) continue;
      const bad = u.page.hreflang
        .map((h) => ({ h, t: s.byUrl.get(h.href) }))
        .filter((x) => x.t && x.t.statusCode !== null && x.t.statusCode !== 200);
      if (bad.length) out.push(finding(I18N001, u.url, `${bad.length} hreflang target(s) do not return 200.`, { targets: bad.slice(0, CAP).map((x) => ({ lang: x.h.lang, url: x.h.href, status: x.t!.statusCode })) }));
    }
    return out;
  },
  explain: {
    why: "Google ignores hreflang alternates that do not return 200, so the language version is not shown.",
    fix: "Point hreflang at the live 200 URL of each language version.",
    acceptance: "Every hreflang target returns 200.",
  },
});

const I18N002 = site({
  id: "I18N-002",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const u of s.urls) {
      if (!u.page || u.statusCode !== 200 || !annotated(u)) continue;
      const missing: { lang: string; url: string }[] = [];
      for (const h of u.page.hreflang) {
        if (h.href === u.url) continue;
        const t = s.byUrl.get(h.href);
        // Only a fetched HTML 200 target can be checked for a return link.
        if (!t?.page || t.statusCode !== 200) continue;
        if (!t.page.hreflang.some((b) => b.href === u.url)) missing.push({ lang: h.lang, url: h.href });
      }
      if (missing.length) out.push(finding(I18N002, u.url, `${missing.length} hreflang alternate(s) do not link back to this page.`, { missing: missing.slice(0, CAP) }));
    }
    return out;
  },
  explain: {
    why: "hreflang must be reciprocal: if page A names B, B must name A, or Google ignores the pair.",
    fix: "Add the return hreflang on each alternate, listing every language version including itself.",
    acceptance: "Every alternate lists this page in its own hreflang set.",
  },
});

const I18N003 = page({
  id: "I18N-003",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const bad = pageHreflang(p)
      .map((h) => ({ value: h.lang, problem: hreflangProblem(h.lang) }))
      .filter((x) => x.problem);
    return bad.length ? [finding(I18N003, p.url, `${bad.length} invalid hreflang value(s): ${bad.map((b) => `"${b.value}"`).slice(0, 5).join(", ")}.`, { invalid: bad.slice(0, CAP) })] : [];
  },
  explain: {
    why: "Google ignores hreflang values that are not a valid language (ISO 639-1), optional script and region (ISO 3166-1 alpha-2).",
    fix: 'Use codes like "en", "en-GB", "zh-Hant" or "x-default".',
    acceptance: "Every hreflang value is valid.",
    docs: "https://developers.google.com/search/docs/specialty/international/localized-versions",
  },
});

const I18N004 = page({
  id: "I18N-004",
  version: 1,
  confidence: "verified",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const hs = pageHreflang(p);
    return hs.length && !hs.some((h) => h.href === p.url) ? [finding(I18N004, p.url, "hreflang set does not include this page itself.", { annotations: hs.slice(0, CAP) })] : [];
  },
  explain: {
    why: "Each language version should list itself in its hreflang set; without it the set is incomplete.",
    fix: "Add an hreflang entry pointing to the page's own URL.",
    acceptance: "The page's hreflang set includes its own URL.",
  },
});

const I18N005 = page({
  id: "I18N-005",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const hs = pageHreflang(p);
    return hs.length && !hs.some((h) => h.lang.trim().toLowerCase() === "x-default") ? [finding(I18N005, p.url, "hreflang set has no x-default.", { languages: hs.map((h) => h.lang).slice(0, CAP) })] : [];
  },
  explain: {
    why: "x-default tells search engines which version to show users whose language matches none of the others.",
    fix: 'Add <link rel="alternate" hreflang="x-default"> pointing at the fallback page (often a language selector).',
    acceptance: "The hreflang set includes x-default.",
  },
});

const I18N006 = site({
  id: "I18N-006",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const u of s.urls) {
      if (!u.page || u.statusCode !== 200 || !annotated(u)) continue;
      const bad = u.page.hreflang
        .map((h) => ({ h, t: s.byUrl.get(h.href) }))
        .filter((x) => x.t?.page && x.t.statusCode === 200 && !isIndexable(x.t) && x.t.page.canonical !== null && x.t.page.canonical !== x.t.url);
      if (bad.length) out.push(finding(I18N006, u.url, `${bad.length} hreflang target(s) are canonicalised to another URL.`, { targets: bad.slice(0, CAP).map((x) => ({ lang: x.h.lang, url: x.h.href, canonical: x.t!.page!.canonical })) }));
    }
    return out;
  },
  explain: {
    why: "hreflang should name canonical URLs; pointing at a canonicalised duplicate sends mixed signals and the pair may be ignored.",
    fix: "Point hreflang at the canonical URL of each language version.",
    acceptance: "Every hreflang target is its own canonical.",
  },
});

export const I18N_RULES = [I18N001, I18N002, I18N003, I18N004, I18N005, I18N006];
