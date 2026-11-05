// Expert-level rules (docs/SPEC.md catalog: CNT-016…021, META-020…023, LNK-015…017, IDX-033/034, I18N-007/008, SD-011):
// the things a senior reviewer notices that a tag-presence check does not. Pure, like every rule. Anything a snapshot
// from before these rules lacks is an absent optional field, and the rule then does not judge that page.
import { finding, isIndexable, type Finding, type PageCtx, type PageRule, type PageView, type SiteRule, type UrlFacts } from "./contract";
import { entities } from "./jsonld";
import { LANGUAGE_MIN_ACCURACY } from "./meta";
import { homeUrl, isHtml200 } from "./util";

const pageRule = (category: PageRule["category"]) => (r: Omit<PageRule, "scope" | "category">): PageRule => ({ scope: "page", category, ...r });
const siteRule = (category: SiteRule["category"]) => (r: Omit<SiteRule, "scope" | "category">): SiteRule => ({ scope: "site", category, ...r });

const meta = (p: Pick<PageView, "head">, name: string): string | null => {
  const t = p.head.find((h) => h.tag === "meta" && (h.attrs.name ?? h.attrs.property ?? "").trim().toLowerCase() === name);
  return t?.attrs.content?.trim() || null;
};
/** Lower-cased letters and digits only, so "Arch-Graphic" and "arch graphic" compare equal. */
const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
const wordsOf = (s: string) => s.trim().split(/\s+/).filter(Boolean);
const isHomePath = (url: string) => new URL(url).pathname === "/";
const isEnglish = (p: Pick<PageView, "language">) => {
  const l = (p.language?.detected ?? p.language?.declared ?? "").toLowerCase();
  return l === "" || l.startsWith("en");
};
const ORG_TYPES = /^(Organization|Corporation|NGO|OnlineBusiness|OnlineStore|LocalBusiness|Store|ProfessionalService|.*Store|.*Business)$/;
const NAMED_TYPES = /^(WebSite|Organization|Corporation|OnlineBusiness|OnlineStore|LocalBusiness|Store|ProfessionalService|.*Store|.*Business)$/;

/** The name the site's own schema gives itself: a top-level entity, not a publisher or organizer nested in another. */
function schemaName(p: Pick<PageView, "jsonLd">, types: RegExp = NAMED_TYPES): string | null {
  for (const e of entities(p.jsonLd)) {
    if (!e.path && e.types.some((t) => types.test(t)) && typeof e.entity.name === "string" && e.entity.name.trim()) return e.entity.name.trim();
  }
  return null;
}
/** The brand a page's own tags give. An Organization on an inner page can be anyone (a supplier, a client), so only the
 * site-wide WebSite entity counts there; on the home page an Organization is the site's own. */
const pageBrand = (p: PageView) => meta(p, "og:site_name") ?? schemaName(p, isHomePath(p.url) ? NAMED_TYPES : /^WebSite$/);

// ---------- content ----------

const cnt = pageRule("content");
/** A fragment ending in one of these is unfinished, or one starting with one of these continues the last. */
const CONNECTORS = new Set(["of", "and", "or", "the", "a", "an", "for", "to", "in", "on", "with", "by", "at", "from", "your", "our", "my", "their", "&", "+", "و", "في", "من"]);
// Calibrated on arch-graphic.com (2026-11): most of the site's 28 adjacent short heading pairs were one phrase split in two,
// and the connector test alone caught 2. A short lead-in before a longer line ("ARCH GRAPHIC" / "3D PRINTING SERVICE COMPANY
// IN UAE") is the usual shape. Two equally short headings ("Rapid" / "Prototyping") read the same as labels ("Spades" /
// "Forks"), so they are left alone; a run of three or more was a list of labels every time.
export const FRAGMENT_FIRST_MAX_WORDS = 4;
export const FRAGMENT_SECOND_MAX_WORDS = 7;
/** A first part this short, before a longer second part, is a lead-in to it. */
export const FRAGMENT_STUB_WORDS = 2;
const CASE_CHANGE_MAX_WORDS = 3;
const isUpper = (s: string) => /\p{L}/u.test(s) && s === s.toUpperCase();

const CNT016 = cnt({
  id: "CNT-016",
  version: 2,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const pairs: string[][] = [];
    for (let i = 1; i < p.outline.length; i++) {
      const [a, b] = [p.outline[i - 1], p.outline[i]];
      // `adjacent`: no text, image, link or control between the two headings in the document.
      if (!b.adjacent || a.level !== b.level) continue;
      const [wa, wb] = [wordsOf(a.text), wordsOf(b.text)];
      if (!wa.length || !wb.length || wa.length > FRAGMENT_FIRST_MAX_WORDS || wb.length > FRAGMENT_SECOND_MAX_WORDS) continue;
      // Three or more in a row are a list of labels, not one phrase.
      if ((a.adjacent && p.outline[i - 2]?.level === a.level) || (p.outline[i + 1]?.adjacent && p.outline[i + 1]?.level === b.level)) continue;
      const end = wa[wa.length - 1].toLowerCase();
      const start = wb[0].toLowerCase();
      const continues =
        CONNECTORS.has(end) ||
        CONNECTORS.has(start) ||
        /^\p{Ll}/u.test(wb[0]) ||
        (wa.length <= FRAGMENT_STUB_WORDS && wb.length > wa.length) ||
        (wa.length <= CASE_CHANGE_MAX_WORDS && isUpper(a.text) !== isUpper(b.text));
      if (continues && !/[.!?:]$/.test(a.text.trim())) pairs.push([a.text, b.text]);
    }
    return pairs.length ? [finding(CNT016, p.url, `${pairs.length} phrase(s) split across heading tags, such as "${pairs[0].join(" / ")}".`, { pairs: pairs.slice(0, 10) })] : [];
  },
  explain: {
    why: "A phrase split across heading tags reads as separate topics in the outline, for screen readers and search engines, so the page's real headline is lost.",
    fix: "Put the whole phrase in one heading, and style its lines with CSS or <span>.",
    acceptance: "No two adjacent short headings read as one phrase.",
  },
});

const CNT017 = cnt({
  id: "CNT-017",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const firstH1 = p.outline.findIndex((h) => h.level === 1);
    const before = (firstH1 < 0 ? p.outline : p.outline.slice(0, firstH1)).filter((h) => h.level === 2 && h.text.trim());
    if (before.length < 2) return [];
    const message = firstH1 < 0 ? `No <h1>, and ${before.length} <h2> headings stand in for it.` : `${before.length} <h2> headings come before the first <h1>.`;
    return [finding(CNT017, p.url, message, { h2: before.slice(0, 10).map((h) => h.text), h1: firstH1 < 0 ? null : p.outline[firstH1].text })];
  },
  explain: {
    why: "Slider and banner titles marked as H2 put secondary text first in the outline, so the page's main topic is not what its structure leads with.",
    fix: "Make the page's main heading the first heading, as its <h1>. Mark slider and banner titles as plain text.",
    acceptance: "Fewer than two H2s come before the H1, and a page with several H2s has an H1.",
  },
});

const STUFF_MIN_WORDS = 100;
// Calibrated on arch-graphic.com (2026-11). At 6 uses and 12 per 1,000 words the rule fired on 372 of 486 pages, half of
// them a product's own name ("burj khalifa", 7 in 496 words) or a term in the menu. At 15 and 30 it keeps the pages whose
// copy repeats one term throughout (home 72 at 39.4, FAQs 52 at 45.7, project pages about 23 at 32).
/** A phrase must repeat at least this often, and at this rate per 1,000 words. */
export const STUFF_MIN_COUNT = 15;
export const STUFF_MIN_RATE = 30;
export const STUFF_MIN_BOLD = 5;
const PHRASE_STOP = new Set(["the", "a", "an", "of", "and", "or", "to", "in", "on", "for", "with", "by", "at", "from", "is", "are", "be", "it", "this", "that", "as", "we", "you", "your", "our", "و", "في", "من", "على", "إلى"]);
const UI_PHRASES = /^(add to (cart|basket|wishlist)|read more|learn more|view (details|more|all)|select options|quick view|shop now|sold out|out of stock|in stock|contact us|load more|show more)$/;
/** Words of a product card or button, which repeat once per card: "31.50 AED Select Options", "View project". */
const CARD_PHRASES = /\b(aed|usd|eur|gbp|sar|vat|select options|view options|view project|add to (cart|basket)|request a quote)\b/;
const phraseTokens = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []);
/** Real words only: a list of "/meta/p-12" link labels is not a phrase. */
const usablePhrase = (t: string[]) => !PHRASE_STOP.has(t[0]) && !PHRASE_STOP.has(t[t.length - 1]) && t.every((w) => w.length > 1 && !/^\p{L}*\p{N}+$/u.test(w)) && t.some((w) => w.length > 2) && !UI_PHRASES.test(t.join(" ")) && !CARD_PHRASES.test(t.join(" "));

/** Count of each 2–4 word phrase in the text. */
function phraseCounts(tokens: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= tokens.length; i++) {
      const t = tokens.slice(i, i + n);
      if (usablePhrase(t)) counts.set(t.join(" "), (counts.get(t.join(" ")) ?? 0) + 1);
    }
  }
  return counts;
}

const CNT018 = cnt({
  id: "CNT-018",
  version: 2,
  confidence: "heuristic",
  impact: 3,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const tokens = phraseTokens(p.mainText);
    const out: { phrase: string; count: number; per1000?: number; inBold?: number }[] = [];
    if (tokens.length >= STUFF_MIN_WORDS) {
      const hits = [...phraseCounts(tokens)]
        .filter(([, c]) => c >= STUFF_MIN_COUNT && (c * 1000) / tokens.length >= STUFF_MIN_RATE)
        .sort((a, b) => b[1] - a[1] || b[0].length - a[0].length);
      // "digital printing dubai" repeating also repeats "digital printing": keep the longest of equally frequent phrases.
      const kept: [string, number][] = [];
      for (const h of hits) if (!kept.some((k) => k[0].includes(h[0]) && k[1] >= h[1])) kept.push(h);
      for (const [phrase, count] of kept.slice(0, 5)) out.push({ phrase, count, per1000: Math.round((count * 10_000) / tokens.length) / 10 });
    }
    const bold = new Map<string, number>();
    for (const s of p.facts?.strong ?? []) {
      const t = phraseTokens(s);
      if (t.length >= 2 && t.length <= 4 && usablePhrase(t)) bold.set(t.join(" "), (bold.get(t.join(" ")) ?? 0) + 1);
    }
    for (const [phrase, inBold] of bold) {
      if (inBold < STUFF_MIN_BOLD) continue;
      const hit = out.find((o) => o.phrase === phrase);
      if (hit) hit.inBold = inBold;
      else out.push({ phrase, count: inBold, inBold });
    }
    if (!out.length) return [];
    const top = out[0];
    return [finding(CNT018, p.url, `"${top.phrase}" appears ${top.count} times${top.per1000 ? ` (${top.per1000} per 1,000 words)` : ""}${top.inBold ? `, ${top.inBold} in bold` : ""}.`, { phrases: out, words: tokens.length })];
  },
  explain: {
    why: "A phrase repeated far beyond natural use reads as written for a machine. It weakens trust in the text and is the pattern search engines' spam policies describe.",
    fix: "Use the phrase where it helps the reader and vary the rest. Keep bold for emphasis, not keywords.",
    acceptance: `No 2–4 word phrase appears ${STUFF_MIN_COUNT}+ times at ${STUFF_MIN_RATE}+ per 1,000 words, or ${STUFF_MIN_BOLD}+ times in bold.`,
  },
});

export const STALE_DAYS = 180;
const ARTICLE_SITEMAP = /(^|[/_-])(post|posts|article|articles|blog|news)[^/]*\.xml/i;

const CNT019 = siteRule("content")({
  id: "CNT-019",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ site, crawl }) {
    let newest: { at: number; date: string; source: string; url: string } | null = null;
    const take = (date: string | null | undefined, source: string, url: string) => {
      const at = date ? Date.parse(date) : NaN;
      if (Number.isFinite(at) && (!newest || at > newest.at)) newest = { at, date: date!, source, url };
    };
    for (const u of site.urls) take(u.page?.published, "article date on the page", u.url);
    for (const d of crawl.sitemaps) if (ARTICLE_SITEMAP.test(new URL(d.url).pathname)) take(d.lastmod?.max, "sitemap lastmod", d.url);
    const found = newest as { at: number; date: string; source: string; url: string } | null;
    // A site with no dated article has nothing to be stale.
    if (!found) return [];
    const age = Math.floor((Date.parse(crawl.startedAt) - found.at) / 86_400_000);
    if (age <= STALE_DAYS) return [];
    return [finding(CNT019, homeUrl(crawl.origin), `The newest article is ${age} days old (${found.date.slice(0, 10)}).`, { newest: found.date, source: found.source, url: found.url, ageDays: age })];
  },
  explain: {
    why: "A blog or news section with nothing new in six months tells readers the site may not be maintained, and leaves recent questions unanswered.",
    fix: "Publish or update an article, or remove the dated section from prominent links.",
    acceptance: `The newest article date is within ${STALE_DAYS} days of the audit.`,
  },
});

const TITLE_SEPARATOR = /\s+[|–—·•:-]\s+/;

const CNT020 = cnt({
  id: "CNT-020",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || !isHomePath(p.url)) return [];
    const logo = p.facts?.logoAlt?.replace(/\blogo\b/gi, "").trim();
    const named: { source: string; name: string }[] = [];
    const add = (source: string, name: string | null | undefined) => {
      if (name && squash(name)) named.push({ source, name: name.trim() });
    };
    add("og:site_name", meta(p, "og:site_name"));
    add("logo alt", logo);
    add("schema name", schemaName(p));
    if (!named.length) return [];
    const same = (a: string, b: string) => squash(a).includes(squash(b)) || squash(b).includes(squash(a));
    // A home title is often "Brand | Tagline" or "Tagline | Brand": it agrees when any part names the brand.
    const parts = (p.titles[0] ?? "").split(TITLE_SEPARATOR);
    if (parts.length > 1 && !parts.some((t) => named.some((n) => same(t, n.name)))) add("title suffix", parts[parts.length - 1]);
    const distinct: { source: string; name: string }[] = [];
    for (const n of named) if (!distinct.some((d) => same(d.name, n.name))) distinct.push(n);
    return distinct.length > 1 ? [finding(CNT020, p.url, `The brand is written differently: ${distinct.map((d) => `"${d.name}" (${d.source})`).join(", ")}.`, { names: named })] : [];
  },
  explain: {
    why: "Search engines and readers connect a business across its pages by its name. Different names across the logo, title, social tags and schema weaken that connection.",
    fix: "Choose one brand name and use it in og:site_name, title suffixes, the logo's alt text and the schema name.",
    acceptance: "All four name the same brand.",
  },
});

const CNT021 = cnt({
  id: "CNT-021",
  version: 1,
  confidence: "heuristic",
  impact: 1,
  needs: ["raw"],
  groupByTemplate: true,
  evaluate({ page: p }) {
    if (!isHtml200(p) || !p.facts?.contacts) return [];
    const phones = new Map<string, Set<string>>();
    const emails = new Map<string, Set<string>>();
    const addPhone = (s: string) => {
      const digits = s.replace(/\D/g, "");
      if (digits.length < 8) return;
      const key = digits.slice(-8);
      phones.set(key, (phones.get(key) ?? new Set()).add(s.replace(/\s+/g, " ").trim()));
    };
    const addEmail = (s: string) => emails.set(s.toLowerCase(), (emails.get(s.toLowerCase()) ?? new Set()).add(s.trim()));
    p.facts.contacts.phones.forEach(addPhone);
    p.facts.contacts.emails.forEach(addEmail);
    for (const e of entities(p.jsonLd)) {
      if (typeof e.entity.telephone === "string") addPhone(e.entity.telephone);
      if (typeof e.entity.email === "string") addEmail(e.entity.email.replace(/^mailto:/i, ""));
    }
    const out: Finding[] = [];
    for (const [kind, map] of [["phone", phones], ["email", emails]] as const) {
      for (const [key, forms] of map) {
        if (forms.size > 1) out.push(finding(CNT021, p.url, `The same ${kind} is written ${forms.size} ways: ${[...forms].slice(0, 5).map((f) => `"${f}"`).join(", ")}.`, { groupKey: `${kind}:${key}`, kind, forms: [...forms].slice(0, 10) }));
      }
    }
    return out;
  },
  explain: {
    why: "Consistent contact details are how search engines and directories match a business across the web, and an inconsistent phone number looks careless.",
    fix: "Use one written format for each phone and email in the page text and in the schema.",
    acceptance: "Each phone and email has one written form on the page and in its schema.",
  },
});

// ---------- metadata ----------

const mta = pageRule("metadata");

const META020 = mta({
  id: "META-020",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p, crawl }) {
    const title = p.titles[0]?.trim();
    if (!isHtml200(p) || !title || p.robots?.noindex.meta || p.robots?.noindex.header) return [];
    const reasons: string[] = [];
    const cased = (title.match(/\p{L}/gu) ?? []).filter((c) => c.toLowerCase() !== c.toUpperCase());
    const allCaps = cased.length >= 8 && cased.every((c) => c === c.toUpperCase());
    if (allCaps) reasons.push("is all caps");
    const brand = crawl.brand ?? pageBrand(p);
    const brandSource = crawl.brand ? "project settings" : meta(p, "og:site_name") ? "og:site_name" : "schema";
    const noBrand = !!brand && !!squash(brand) && !squash(title).includes(squash(brand));
    if (noBrand) reasons.push(`does not name the brand "${brand}"`);
    return reasons.length ? [finding(META020, p.url, `The title ${reasons.join(" and ")}.`, { title, allCaps, noBrand, brand: brand ?? null, brandSource: brand ? brandSource : null })] : [];
  },
  explain: {
    why: "An all-caps title reads as shouting and is harder to scan. A title without the brand loses recognition in search results.",
    fix: "Write the title in sentence or title case, and end it with the brand name.",
    acceptance: "The title is not all caps and names the brand.",
  },
});

const VERBS = /\b(is|are|was|were|be|has|have|had|do|does|can|will|helps?|makes?|gets?|offers?|provides?|delivers?|creates?|designs?|builds?|prints?|sells?|supplies|supply|brings?|gives?|uses?|works?|turns?|includes?|covers?|explains?|shows?|lets?|choose|compare|find|learn|discover|explore|see|try|start|read|buy|shop|order|book|call|contact|request|get|visit|view|browse|download|ask|hire|join|save|upload|schedule)\b/i;
/** Words that ask the reader to act. "Read" and friends count: a description only has to invite the click. */
const CALL_TO_ACTION = /\b(call|contact|book|buy|shop|order|request|get|learn|discover|explore|see|find|try|start|read|download|browse|compare|view|visit|sign up|join|ask|enquire|inquire|upload|save|choose|hire|schedule|claim|speak|talk|order)\b/i;
export const LIST_MIN_SEPARATORS = 3;

const META021 = mta({
  id: "META-021",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    const d = p.descriptions[0]?.trim();
    if (!isHtml200(p) || !d || p.robots?.noindex.meta || p.robots?.noindex.header) return [];
    const parts = d.split(/[|,،]/).map((s) => s.trim()).filter(Boolean);
    const separators = parts.length - 1;
    const english = isEnglish(p);
    const short = parts.length > 0 && parts.reduce((n, s) => n + wordsOf(s).length, 0) / parts.length <= 4;
    const list = separators >= LIST_MIN_SEPARATORS && short && (!english || !VERBS.test(d));
    if (list) return [finding(META021, p.url, `The description is a keyword list (${separators} separators, no verb).`, { description: d, kind: "keyword_list" })];
    // Calls to action are judged in English only: the list of words does not carry to other languages.
    if (english && !CALL_TO_ACTION.test(d)) return [finding(META021, p.url, "The description has no call to action.", { description: d, kind: "no_cta" })];
    return [];
  },
  explain: {
    why: "The description is the page's pitch in search results. A list of keywords gives no reason to click, and neither does one that never says what to do next.",
    fix: "Write one sentence on what the page gives the reader, and end with what to do: call, compare, get a quote.",
    acceptance: "The description is a sentence with a verb and a call to action.",
  },
});

export const LARGE_CARD_RATIO = { min: 1.6, max: 2.2 };
export const SQUARE_CARD_RATIO = { min: 0.8, max: 1.25 };

const META022 = mta({
  id: "META-022",
  version: 1,
  confidence: "heuristic",
  impact: 1,
  needs: ["raw"],
  groupByTemplate: true,
  evaluate({ page: p, crawl }) {
    const card = p.facts?.twitterCard?.trim().toLowerCase();
    const image = p.facts?.og.image;
    if (!isHtml200(p) || !image || (card !== "summary_large_image" && card !== "summary")) return [];
    // The tags the page declares, else what the resource phase read from the image itself.
    const declared = { width: Number(meta(p, "og:image:width")), height: Number(meta(p, "og:image:height")) };
    const res = crawl.resources.images.get(image);
    const width = declared.width > 0 ? declared.width : res?.width;
    const height = declared.height > 0 ? declared.height : res?.height;
    if (!width || !height) return [];
    const ratio = width / height;
    const want = card === "summary" ? SQUARE_CARD_RATIO : LARGE_CARD_RATIO;
    if (ratio >= want.min && ratio <= want.max) return [];
    const needs = card === "summary" ? "about 1:1" : "about 1.91:1";
    return [finding(META022, p.url, `og:image is ${width}×${height} (${ratio.toFixed(2)}:1); twitter:card ${card} needs ${needs}.`, { groupKey: image, image, width, height, ratio: Math.round(ratio * 100) / 100, card })];
  },
  explain: {
    why: "A social card crops an image of the wrong shape, which can cut off the logo or the message when the page is shared.",
    fix: "Use a 1200×630 image for summary_large_image, or a square one for summary.",
    acceptance: "The og:image ratio fits the twitter:card type.",
  },
});

const META023 = mta({
  id: "META-023",
  version: 1,
  confidence: "verified",
  impact: 1,
  needs: ["raw"],
  groupByTemplate: true,
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const out: Finding[] = [];
    for (const h of p.head) {
      if (h.tag !== "meta" || (h.attrs.name ?? "").trim().toLowerCase() !== "generator") continue;
      const content = (h.attrs.content ?? "").trim();
      if (/\d/.test(content)) out.push(finding(META023, p.url, `Generator tag exposes "${content.slice(0, 80)}".`, { groupKey: content.split(/[\s;]/)[0].toLowerCase(), generator: content.slice(0, 200) }));
    }
    return out;
  },
  explain: {
    why: "A public CMS name and version tells an attacker which known vulnerabilities to try. It does nothing for readers or search engines.",
    fix: "Remove the generator tag in the CMS or theme.",
    acceptance: "No meta generator tag names a version.",
  },
});

// ---------- links ----------

const lnk = pageRule("links");
export const NAV_MAX_LINKS = 60;
export const NAV_DUPLICATE_MIN_LINKS = 5;

const LNK015 = lnk({
  id: "LNK-015",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  groupByTemplate: true,
  evaluate({ page: p }) {
    const blocks = p.facts?.navBlocks;
    if (!isHtml200(p) || !blocks?.length) return [];
    const total = p.facts!.navLinks ?? 0;
    const counts = new Map<string, number>();
    for (const b of blocks) if (b.links >= NAV_DUPLICATE_MIN_LINKS) counts.set(b.sig, (counts.get(b.sig) ?? 0) + 1);
    const copies = Math.max(0, ...counts.values());
    const reasons = [...(total > NAV_MAX_LINKS ? [`${total} navigation links`] : []), ...(copies >= 2 ? [`the same navigation rendered ${copies} times`] : [])];
    return reasons.length ? [finding(LNK015, p.url, `Navigation bloat: ${reasons.join(" and ")}.`, { navLinks: total, copies, blocks: blocks.length })] : [];
  },
  explain: {
    why: "Every page repeats its navigation. Too many links, or a copy for desktop and another for mobile, dilutes each link's weight and adds markup to every page.",
    fix: `Keep the main navigation under ${NAV_MAX_LINKS} links, and render one menu that CSS adapts to each screen size.`,
    acceptance: `At most ${NAV_MAX_LINKS} navigation links, and one copy of each navigation in the DOM.`,
  },
});

/** Conversion intent in link text, and words that show a target page serves it (title, H1 or path). */
const CTA_INTENT: { intent: string; anchor: RegExp; target: RegExp }[] = [
  { intent: "upload", anchor: /^(?:please )?upload\b/i, target: /upload|file|artwork|design|submit/i },
  { intent: "quote", anchor: /^(?:get|request|ask for|free)?\s*(?:a |your |free )*quot(?:e|ation)\b/i, target: /quot|estimate|request|contact|enquir|inquir/i },
  { intent: "contact", anchor: /^(?:please )?contact\b/i, target: /contact|reach|enquir|inquir|get in touch|support/i },
  { intent: "buy", anchor: /^(?:buy|order|shop)\b/i, target: /buy|order|shop|store|product|cart|checkout|price/i },
  { intent: "book", anchor: /^book (?:a |an |your |now|online|today)/i, target: /book|appointment|schedule|reserv|consult|contact/i },
  { intent: "call", anchor: /^call (?:us|now|today)\b/i, target: /contact|call|phone|reach/i },
];
export const CTA_MAX_WORDS = 5;

const LNK016 = lnk({
  id: "LNK-016",
  version: 1,
  confidence: "heuristic",
  impact: 3,
  needs: ["raw"],
  groupByTemplate: true,
  evaluate({ page: p, site, crawl }: PageCtx) {
    if (!isHtml200(p)) return [];
    const out: Finding[] = [];
    const seen = new Set<string>();
    const home = homeUrl(crawl.origin);
    for (const l of p.links) {
      const anchor = l.anchor?.trim();
      if (!anchor || l.via !== "link" || wordsOf(anchor).length > CTA_MAX_WORDS) continue;
      const cta = CTA_INTENT.find((c) => c.anchor.test(anchor));
      if (!cta) continue;
      const key = `${anchor.toLowerCase()} -> ${l.href}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const t = site.byUrl.get(l.href);
      if (l.href === home) {
        out.push(finding(LNK016, p.url, `"${anchor}" links to the homepage.`, { groupKey: key, anchor, target: l.href, intent: cta.intent, reason: "homepage" }));
        continue;
      }
      // Judged only when the target's title is known (an internal page the crawl answered).
      if (!t?.page?.title) continue;
      const about = `${t.page.title} ${t.page.h1 ?? ""} ${new URL(l.href).pathname}`;
      if (!cta.target.test(about)) out.push(finding(LNK016, p.url, `"${anchor}" links to "${t.page.title}", which does not offer that.`, { groupKey: key, anchor, target: l.href, targetTitle: t.page.title, intent: cta.intent, reason: "title_mismatch" }));
    }
    return out;
  },
  explain: {
    why: "A button that promises an action and lands somewhere else loses the visitor at the point they were ready to convert.",
    fix: "Point the link at the page that does what its text says, or change the text.",
    acceptance: "Conversion links land on a page that matches their text.",
  },
});

const LNK017 = siteRule("links")({
  id: "LNK-017",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw", "graph"],
  evaluate({ site }) {
    /** The URL really is the page's address: answered 200 and names no other canonical. A bad target is IDX-012/013/014's. */
    const live = (url: string) => {
      const t = site.byUrl.get(url);
      return !!t?.page && t.statusCode === 200 && (!t.page.canonical || t.page.canonical === url) && !t.page.noindex;
    };
    // Every other URL that internal links use for a destination, and how it gets there.
    const aliases = new Map<string, { url: string; via: "redirect" | "canonical"; pages: number }[]>();
    for (const u of site.urls) {
      const pages = u.directLinks ?? 0;
      if (pages < 1) continue;
      let destination: string | null = null;
      let via: "redirect" | "canonical" = "redirect";
      if (u.state === "redirected" && u.redirectTarget) destination = u.redirectTarget;
      // A parameter URL canonicalising to its base is the normal way to handle one, not a second URL for the page.
      else if (u.page?.canonical && u.page.canonical !== u.url && !new URL(u.url).search) [destination, via] = [u.page.canonical, "canonical"];
      if (!destination || destination === u.url || !live(destination)) continue;
      let sameSite = false;
      try {
        const [to, from] = [new URL(destination), new URL(u.url)];
        // A link differing only by http: is LNK-011's finding.
        sameSite = to.hostname === from.hostname && `${to.pathname}${to.search}` !== `${from.pathname}${from.search}`;
      } catch {
        // an unparseable target is another rule's finding
      }
      if (sameSite) aliases.set(destination, [...(aliases.get(destination) ?? []), { url: u.url, via, pages }]);
    }
    const out: Finding[] = [];
    for (const [destination, forms] of aliases) {
      const direct = site.byUrl.get(destination)?.directLinks ?? 0;
      // One redirected URL beside the real one is a single stale link: LNK-002 reports it, on the page to fix.
      if (forms.length + (direct > 0 ? 1 : 0) < 2 || (forms.length === 1 && forms[0].via === "redirect")) continue;
      const shown = [...forms].sort((a, b) => b.pages - a.pages || (a.url < b.url ? -1 : 1));
      out.push(finding(LNK017, destination, `Internal links reach this page by ${forms.length + (direct > 0 ? 1 : 0)} different URLs: ${shown.slice(0, 3).map((f) => f.url).join(", ")}${direct > 0 ? " and this URL itself" : ""}.`, { destination, directLinks: direct, forms: shown.slice(0, 10), formCount: forms.length }));
    }
    return out;
  },
  explain: {
    why: "Linking to one page by two URLs splits its signals, wastes crawl budget on redirects and shows search engines an uncertain preferred URL.",
    fix: "Change internal links to use the page's final, canonical URL.",
    acceptance: "Internal links use the destination's canonical URL.",
  },
});

// ---------- indexability ----------

const idx = siteRule("indexability");
const COMMERCE_UTILITY = /(?:^|\/)(cart|basket|checkout|my-account|wishlist|compare)(?:\/|$)/i;

const IDX033 = idx({
  id: "IDX-033",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["raw"],
  evaluate({ site }) {
    const out: Finding[] = [];
    for (const u of site.urls) {
      if (!isIndexable(u)) continue;
      const m = COMMERCE_UTILITY.exec(decodeURI(new URL(u.url).pathname));
      if (m) out.push(finding(IDX033, u.url, `The ${m[1].toLowerCase()} page can be indexed.`, { utility: m[1].toLowerCase() }));
    }
    return out;
  },
  explain: {
    why: "Cart, checkout, account, wishlist and compare pages have nothing to rank for. Indexing them wastes crawl budget and lets near-empty pages into search results.",
    fix: 'Add <meta name="robots" content="noindex"> to these pages.',
    acceptance: "These pages carry noindex.",
  },
});

const FACET_QUERY = /(?:^|[?&])(filter_[^=&]*|pa_[^=&]*|min_price|max_price|attribute[^=&]*)=/i;
const FACET_PATH = /\/(pa_[^/]+|product-attribute|attribute|facet|filter)\//i;

const IDX034 = idx({
  id: "IDX-034",
  version: 1,
  confidence: "heuristic",
  impact: 3,
  needs: ["raw"],
  evaluate({ site }) {
    const out: Finding[] = [];
    for (const u of site.urls) {
      if (!isIndexable(u)) continue;
      const parsed = new URL(u.url);
      const taxonomy = u.page?.bodyClass?.match(/\btax-(pa_[\w-]+)/)?.[1];
      const reason = FACET_QUERY.test(parsed.search) ? "filter parameter" : FACET_PATH.test(parsed.pathname) ? "facet path" : taxonomy ? `attribute archive (${taxonomy})` : null;
      if (reason) out.push(finding(IDX034, u.url, `This ${reason} page can be indexed, with no canonical to its parent.`, { reason, taxonomy: taxonomy ?? null }));
    }
    return out;
  },
  explain: {
    why: "Filter and attribute pages multiply into thousands of thin variations of one listing, which dilute the category page and waste crawl budget.",
    fix: "Add a canonical to the parent category, or noindex, on filter and attribute pages you do not want to rank.",
    acceptance: "Filter and attribute pages canonicalise to the parent or carry noindex.",
  },
});

// ---------- international ----------

const i18n = siteRule("international");
const primary = (l: string | null | undefined) => (l ?? "").trim().toLowerCase().split(/[-_]/)[0];
const MIN_LANGUAGE_PAGES = 2;
const MIN_LANGUAGE_SHARE = 0.02;

const I18N007 = i18n({
  id: "I18N-007",
  version: 1,
  confidence: "heuristic",
  impact: 3,
  needs: ["raw"],
  evaluate({ site, crawl }) {
    const judged = site.urls.filter((u) => u.statusCode === 200 && u.page?.language?.detected && (u.page.language.accuracy ?? 0) >= LANGUAGE_MIN_ACCURACY);
    const byLang = new Map<string, UrlFacts[]>();
    for (const u of judged) byLang.set(primary(u.page!.language!.detected), [...(byLang.get(primary(u.page!.language!.detected)) ?? []), u]);
    const languages = [...byLang].filter(([, us]) => us.length >= Math.max(MIN_LANGUAGE_PAGES, judged.length * MIN_LANGUAGE_SHARE));
    if (languages.length < 2) return [];
    const inLanguages = languages.flatMap(([, us]) => us);
    const shared = (read: (u: UrlFacts) => string) => {
      const owners = new Map<string, Set<string>>();
      for (const [lang, us] of languages) for (const u of us) if (read(u)) owners.set(read(u), (owners.get(read(u)) ?? new Set()).add(lang));
      return [...owners].filter(([, l]) => l.size > 1).map(([v]) => v);
    };
    const sharedLang = shared((u) => primary(u.page!.language!.declared));
    const sharedLocale = shared((u) => (u.page!.ogLocale ?? "").toLowerCase());
    const withHreflang = inLanguages.filter((u) => u.page!.hreflang.length > 0).length;
    const reasons = [
      ...(sharedLang.length ? [`pages in different languages share html lang "${sharedLang.join(", ")}"`] : []),
      ...(sharedLocale.length ? [`share og:locale "${sharedLocale.join(", ")}"`] : []),
      ...(withHreflang === 0 ? ["no page has hreflang"] : []),
    ];
    if (!reasons.length) return [];
    const langs = languages.map(([l, us]) => ({ language: l, pages: us.length, sample: us.slice(0, 5).map((u) => u.url) }));
    return [finding(I18N007, homeUrl(crawl.origin), `Mixed-language site without language handling: ${reasons.join("; ")}.`, { languages: langs, sharedLang, sharedLocale, withHreflang })];
  },
  explain: {
    why: "Without correct html lang, og:locale and hreflang, search engines can show a page in the wrong language to the wrong audience.",
    fix: "Declare each page's real language in html lang and og:locale, and link language versions with hreflang.",
    acceptance: "Pages in different languages declare different languages and carry hreflang.",
  },
});

const hasNonLatin = (s: string) => /\p{L}/u.test(s) && /[^\p{Script=Latin}\P{L}]/u.test(s);

const I18N008 = i18n({
  id: "I18N-008",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ site, crawl }) {
    const sections = new Map<string, { encoded: string[]; latin: string[] }>();
    for (const u of site.urls) {
      if (!u.page) continue;
      const parsed = new URL(u.url);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (!segments.length) continue;
      const section = segments.length > 1 ? `/${segments[0]}/` : "/";
      const slug = segments[segments.length - 1];
      let decoded = slug;
      try {
        decoded = decodeURIComponent(slug);
      } catch {
        continue;
      }
      const s = sections.get(section) ?? { encoded: [], latin: [] };
      if (hasNonLatin(decoded)) s.encoded.push(u.url);
      else if (/[a-z]/i.test(decoded)) s.latin.push(u.url);
      sections.set(section, s);
    }
    const out: Finding[] = [];
    for (const [section, s] of sections) {
      if (s.encoded.length && s.latin.length) {
        out.push(finding(I18N008, new URL(section, homeUrl(crawl.origin)).toString(), `Section ${section} mixes ${s.encoded.length} percent-encoded non-Latin slug(s) with ${s.latin.length} Latin slug(s).`, { section, encoded: s.encoded.length, latin: s.latin.length, encodedSample: s.encoded.slice(0, 5), latinSample: s.latin.slice(0, 5) }));
      }
    }
    return out;
  },
  explain: {
    why: "A non-Latin slug is sent as a long run of percent codes, which is hard to share and read. Mixing the two in one section shows no single URL policy.",
    fix: "Choose one slug script per section, usually transliterated Latin, and redirect the old URLs.",
    acceptance: "Each section's slugs use one script.",
  },
});

// ---------- structured data ----------

const SD011 = pageRule("structured_data")({
  id: "SD-011",
  version: 1,
  confidence: "heuristic",
  impact: 3,
  needs: ["raw"],
  groupByTemplate: true,
  evaluate({ page: p }) {
    if (!isHtml200(p)) return [];
    const out: Finding[] = [];
    for (const e of entities(p.jsonLd)) {
      const type = e.types.find((t) => ORG_TYPES.test(t));
      if (!type) continue;
      const props = ["aggregateRating", "review", "reviews"].filter((k) => e.entity[k] !== undefined && e.entity[k] !== null);
      if (props.length) out.push(finding(SD011, p.url, `${type} carries ${props.join(" and ")} about itself.`, { groupKey: type, type, properties: props, at: e.path || "(top level)" }));
    }
    return out;
  },
  explain: {
    why: "Google's review snippet guidelines do not show ratings a business publishes about itself on its own site, and marking them up can draw a manual action.",
    fix: "Remove aggregateRating and review from Organization and LocalBusiness. Mark up reviews of specific products or services instead.",
    acceptance: "No Organization or LocalBusiness entity carries aggregateRating or review.",
    docs: "https://developers.google.com/search/docs/appearance/structured-data/review-snippet",
  },
});

export const EXPERT_RULES = {
  IDX: [IDX033, IDX034],
  META: [META020, META021, META022, META023],
  CNT: [CNT016, CNT017, CNT018, CNT019, CNT020, CNT021],
  LNK: [LNK015, LNK016, LNK017],
  I18N: [I18N007, I18N008],
  SD: [SD011],
};
