// Content rules (docs/SPEC.md catalog, CNT).
import { simhashSimilarity } from "../snapshot/text";
import { finding, isIndexable, type Finding, type PageRule, type SiteRule, type UrlFacts } from "./contract";
import { groupBy, isHtml200, meaningfulTerms, others } from "./util";

const page = (r: Omit<PageRule, "scope" | "category">): PageRule => ({ scope: "page", category: "content", ...r });
const site = (r: Omit<SiteRule, "scope" | "category">): SiteRule => ({ scope: "site", category: "content", ...r });

/** CNT-005 threshold (main-content words); the spec allows it to be configured, this is the default. */
export const THIN_WORDS = 200;
/** CNT-007: SimHash similarity of the main-content text at or above this is a near duplicate. */
export const NEAR_DUPLICATE = 0.92;
/** CNT-007 compares only pages with at least this many main-content words: short pages share too much by chance. */
export const NEAR_DUPLICATE_MIN_WORDS = 100;
/** CNT-008: boilerplate share above this is flagged, on pages with at least BOILERPLATE_MIN_CHARS of body text. */
export const BOILERPLATE_MAX = 0.8;
export const BOILERPLATE_MIN_CHARS = 200;
/** CNT-012: pages of at least this many HTML bytes whose visible text is under this share of them. */
export const TEXT_RATIO_MIN_BYTES = 20_000;
export const TEXT_RATIO_MIN = 0.1;
/** CNT-011 reads only the start of the main text, where an error message would be. */
export const NOT_FOUND_SCAN_CHARS = 1_000;

const h1s = (p: { outline: { level: number; text: string }[] }) => p.outline.filter((h) => h.level === 1);

const CNT001 = page({
  id: "CNT-001",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["raw"],
  evaluate: ({ page: p }) => (isHtml200(p) && h1s(p).length === 0 ? [finding(CNT001, p.url, "No <h1> on the page.")] : []),
  explain: { why: "The H1 states the page's main topic for readers and search engines.", fix: "Add one <h1> that names what the page is about.", acceptance: "The page has an <h1> with text." },
});

const CNT002 = page({
  id: "CNT-002",
  version: 1,
  confidence: "heuristic",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    const h = h1s(p);
    return isHtml200(p) && h.length > 1 ? [finding(CNT002, p.url, `${h.length} <h1> elements.`, { h1: h.slice(0, 10).map((x) => x.text) })] : [];
  },
  explain: { why: "Several H1s blur which topic is the page's main one.", fix: "Keep one <h1>; demote the others to <h2>.", acceptance: "Exactly one <h1>." },
});

const CNT003 = page({
  id: "CNT-003",
  version: 1,
  confidence: "verified",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const empty = p.outline.filter((h) => !h.text.trim());
    return empty.length ? [finding(CNT003, p.url, `${empty.length} empty heading(s).`, { levels: empty.map((h) => `h${h.level}`) })] : [];
  },
  explain: { why: "Empty headings break the document outline for screen readers and carry no topic signal.", fix: "Give each heading text, or remove it.", acceptance: "No heading element is empty." },
});

const CNT004 = page({
  id: "CNT-004",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    let prev = 0;
    for (const h of p.outline) {
      if (prev && h.level > prev + 1) return [finding(CNT004, p.url, `Heading jumps from h${prev} to h${h.level}.`, { from: prev, to: h.level, text: h.text })];
      prev = h.level;
    }
    return [];
  },
  explain: { why: "Skipped levels make the outline harder to navigate with assistive technology.", fix: "Nest headings one level at a time (h2 under h1, h3 under h2).", acceptance: "No heading is more than one level deeper than the one before it." },
});

const CNT005 = page({
  id: "CNT-005",
  version: 1,
  confidence: "heuristic",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || p.robots?.noindex.meta || p.robots?.noindex.header) return [];
    return p.wordCount < THIN_WORDS ? [finding(CNT005, p.url, `${p.wordCount} words of main content (threshold ${THIN_WORDS}).`, { words: p.wordCount, threshold: THIN_WORDS })] : [];
  },
  explain: { why: "Pages with little unique content rarely rank and can lower the perceived quality of the site.", fix: "Expand the page with useful, specific content, or noindex / consolidate it.", acceptance: `At least ${THIN_WORDS} words of main content, or the page is noindexed.` },
});

const CNT006 = site({
  id: "CNT-006",
  version: 1,
  confidence: "verified",
  impact: 4,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    for (const [hash, group] of groupBy(s.urls.filter(isIndexable), (u) => u.page!.textHash)) {
      if (group.length < 2) continue;
      for (const u of group) out.push(finding(CNT006, u.url, `Main content is identical to ${group.length - 1} other indexable page(s).`, { textHash: hash, others: others(group, u), groupSize: group.length }));
    }
    return out;
  },
  explain: { why: "Search engines index one copy of duplicate content and may pick the wrong one.", fix: "Merge the pages, or point duplicates at the preferred URL with a canonical.", acceptance: "No other indexable page has the same main content." },
});

/** 64-bit SimHashes split into 8 bands of 8 bits. Similarity ≥ 0.9 means at most 6 differing bits, so two near
 * duplicates share at least 2 bands; comparing only pairs that share a band finds every pair without n² work. */
const BANDS = 8;
function nearDuplicatePairs(pages: UrlFacts[]): Map<UrlFacts, { url: string; similarity: number }[]> {
  const buckets = new Map<string, number[]>();
  pages.forEach((u, i) => {
    for (let b = 0; b < BANDS; b++) {
      const key = `${b}:${u.page!.simhash!.slice(b * 2, b * 2 + 2)}`;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(i);
    }
  });
  const seen = new Set<number>();
  const out = new Map<UrlFacts, { url: string; similarity: number }[]>();
  const add = (a: UrlFacts, b: UrlFacts, similarity: number) => {
    if (!out.has(a)) out.set(a, []);
    out.get(a)!.push({ url: b.url, similarity });
  };
  for (const idx of buckets.values()) {
    for (let x = 0; x < idx.length; x++) {
      for (let y = x + 1; y < idx.length; y++) {
        const i = idx[x];
        const j = idx[y];
        const key = i * pages.length + j;
        if (seen.has(key)) continue;
        seen.add(key);
        const a = pages[i];
        const b = pages[j];
        if (a.page!.textHash && a.page!.textHash === b.page!.textHash) continue; // exact duplicates are CNT-006
        const sim = simhashSimilarity(a.page!.simhash!, b.page!.simhash!);
        if (sim < NEAR_DUPLICATE) continue;
        add(a, b, sim);
        add(b, a, sim);
      }
    }
  }
  return out;
}

const CNT007 = site({
  id: "CNT-007",
  version: 2,
  confidence: "heuristic",
  impact: 3,
  needs: ["graph"],
  evaluate({ site: s }) {
    const pages = s.urls.filter((u) => isIndexable(u) && u.page!.simhash && u.page!.wordCount >= NEAR_DUPLICATE_MIN_WORDS);
    const out: Finding[] = [];
    for (const [u, matches] of nearDuplicatePairs(pages)) {
      matches.sort((a, b) => b.similarity - a.similarity || a.url.localeCompare(b.url));
      out.push(finding(CNT007, u.url, `Main content is at least ${Math.round(NEAR_DUPLICATE * 100)}% similar to ${matches.length} other indexable page(s) (main content, boilerplate excluded).`, { matches: matches.slice(0, 10).map((m) => ({ url: m.url, similarity: Math.round(m.similarity * 1000) / 1000 })), count: matches.length }));
    }
    return out;
  },
  explain: { why: "Near-identical pages compete with each other and dilute ranking signals.", fix: "Differentiate the pages or consolidate them with a canonical or redirect.", acceptance: `No other indexable page with ${NEAR_DUPLICATE_MIN_WORDS}+ main-content words is ${Math.round(NEAR_DUPLICATE * 100)}% or more similar.` },
});

const CNT008 = page({
  id: "CNT-008",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || !p.facts || p.facts.bodyTextChars < BOILERPLATE_MIN_CHARS) return [];
    const share = 1 - Math.min(p.facts.mainTextChars, p.facts.bodyTextChars) / p.facts.bodyTextChars;
    return share > BOILERPLATE_MAX ? [finding(CNT008, p.url, `${Math.round(share * 100)}% of the visible text is navigation, header or footer.`, { boilerplate: Math.round(share * 1000) / 1000, bodyTextChars: p.facts.bodyTextChars, mainTextChars: p.facts.mainTextChars })] : [];
  },
  explain: { why: "When template text dwarfs the page's own content, the page says little that is unique.", fix: "Add main content, or trim repeated navigation and footer text.", acceptance: `Boilerplate at most ${BOILERPLATE_MAX * 100}% of visible text.` },
});

const CNT009 = page({
  id: "CNT-009",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    const title = p.titles[0];
    const h1 = h1s(p).find((h) => h.text.trim())?.text;
    if (!isHtml200(p) || !title || !h1) return [];
    const t = meaningfulTerms(title);
    const h = meaningfulTerms(h1);
    if (!t.size || !h.size) return [];
    for (const w of t) if (h.has(w)) return [];
    return [finding(CNT009, p.url, "Title and H1 share no meaningful words.", { title, h1 })];
  },
  explain: { why: "A title and H1 about different things send mixed topic signals.", fix: "Make the title and H1 describe the same topic.", acceptance: "Title and H1 share at least one meaningful word." },
});

/** Unambiguous filler text; ordinary words like "TODO" or "coming soon" are left out to avoid false positives. */
const PLACEHOLDER = /\blorem ipsum\b|\bdolor sit amet\b|\bconsectetur adipiscing elit\b|\b(?:insert|add|your) (?:text|content|copy) here\b|\bplaceholder text\b/i;
const CNT010 = page({
  id: "CNT-010",
  version: 1,
  confidence: "verified",
  impact: 4,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const m = PLACEHOLDER.exec(p.mainText) ?? PLACEHOLDER.exec(p.titles[0] ?? "");
    return m ? [finding(CNT010, p.url, `Placeholder text: "${m[0]}".`, { match: m[0], context: p.mainText.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40) })] : [];
  },
  explain: { why: "Placeholder text signals an unfinished page to users and search engines.", fix: "Replace the placeholder with real content, or unpublish the page.", acceptance: "No placeholder text on the page." },
});

const NOT_FOUND = /\b404\b|\bnot found\b|\bpage (?:does not|doesn['’]t) exist\b/i;
const CNT011 = page({
  id: "CNT-011",
  version: 1,
  confidence: "heuristic",
  impact: 4,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const head = p.mainText.slice(0, NOT_FOUND_SCAN_CHARS);
    const m = NOT_FOUND.exec(head);
    return m ? [finding(CNT011, p.url, `Page returns 200 but says "${m[0]}".`, { match: m[0], context: head.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40) })] : [];
  },
  explain: { why: "An error message served with status 200 gets indexed as a real page (a soft 404).", fix: "Return 404 or 410 for missing content, or fix the page.", acceptance: "The page no longer shows a not-found message with status 200." },
});

const CNT012 = page({
  id: "CNT-012",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || !p.facts || p.facts.htmlBytes < TEXT_RATIO_MIN_BYTES) return [];
    const ratio = p.facts.bodyTextChars / p.facts.htmlBytes;
    return ratio < TEXT_RATIO_MIN ? [finding(CNT012, p.url, `Visible text is ${(ratio * 100).toFixed(1)}% of the HTML.`, { ratio: Math.round(ratio * 1000) / 1000, htmlBytes: p.facts.htmlBytes, textChars: p.facts.bodyTextChars })] : [];
  },
  explain: { why: "Heavy markup with little text slows pages and can hide the content's substance.", fix: "Move inline scripts and styles to files and trim unused markup.", acceptance: `Text at least ${TEXT_RATIO_MIN * 100}% of the HTML.` },
});

export const CNT_RULES = [CNT001, CNT002, CNT003, CNT004, CNT005, CNT006, CNT007, CNT008, CNT009, CNT010, CNT011, CNT012];
