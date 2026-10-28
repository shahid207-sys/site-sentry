// Metadata rules (docs/SPEC.md catalog, META).
import { descriptionPixels, titlePixels } from "../snapshot/text";
import { finding, isIndexable, type Finding, type PageRule, type SiteRule, type UrlFacts } from "./contract";
import { resolveOgImage } from "./probe-types";
import { groupBy, homeUrl, isHtml200, others } from "./util";

const page = (r: Omit<PageRule, "scope" | "category">): PageRule => ({ scope: "page", category: "metadata", ...r });
const site = (r: Omit<SiteRule, "scope" | "category">): SiteRule => ({ scope: "site", category: "metadata", ...r });

export const TITLE_MAX_PX = 580;
export const TITLE_MIN_CHARS = 20;
export const DESCRIPTION_MAX_PX = 920;
export const DESCRIPTION_MIN_CHARS = 70;
/** META-012 flags a mismatch only when the detector is at least this sure (tinyld accuracy, 0–1). */
export const LANGUAGE_MIN_ACCURACY = 0.9;
/** …and the main text has at least this many words. */
export const LANGUAGE_MIN_WORDS = 40;
/** META-007 judges templates with at least this many pages. */
export const TEMPLATE_MIN_PAGES = 3;

const META001 = page({
  id: "META-001",
  version: 1,
  confidence: "verified",
  impact: 5,
  needs: ["raw"],
  evaluate: ({ page: p }) => (isHtml200(p) && p.titles.length === 0 ? [finding(META001, p.url, "No <title> element.")] : []),
  explain: { why: "The title is the main label search results show; without one, search engines write their own.", fix: "Add one descriptive <title> in <head>.", acceptance: "The page has exactly one non-empty <title>." },
});

const META002 = page({
  id: "META-002",
  version: 1,
  confidence: "verified",
  impact: 5,
  needs: ["raw"],
  evaluate: ({ page: p }) => (isHtml200(p) && p.titles.length > 0 && p.titles[0] === "" ? [finding(META002, p.url, "The <title> element is empty.")] : []),
  explain: { why: "An empty title is as bad as none: search engines generate one from the page.", fix: "Write a descriptive title for this page.", acceptance: "The first <title> contains text." },
});

const META003 = page({
  id: "META-003",
  version: 1,
  confidence: "verified",
  impact: 3,
  needs: ["raw"],
  evaluate: ({ page: p }) => (isHtml200(p) && p.titles.length > 1 ? [finding(META003, p.url, `${p.titles.length} <title> elements.`, { titles: p.titles.slice(0, 10) })] : []),
  explain: { why: "Browsers and crawlers use the first title; the others signal a template or plugin conflict.", fix: "Remove the extra <title> elements.", acceptance: "Exactly one <title>." },
});

function duplicateRule(id: "META-004" | "META-009", field: "title" | "description", confidence: "verified" | "heuristic", impact: 2 | 3): SiteRule {
  const rule: SiteRule = site({
    id,
    version: 1,
    confidence,
    impact,
    needs: ["graph"],
    evaluate({ site: s }) {
      const out: Finding[] = [];
      for (const [value, group] of groupBy(s.urls.filter(isIndexable), (u) => u.page![field] || null)) {
        if (group.length < 2) continue;
        for (const u of group) out.push(finding(rule, u.url, `Same ${field} as ${group.length - 1} other indexable page(s).`, { [field]: value, others: others(group, u), groupSize: group.length }));
      }
      return out;
    },
    explain: {
      why: `Identical ${field}s make pages look interchangeable in search results and hint at duplicate content.`,
      fix: `Write a ${field} that describes what is unique about each page.`,
      acceptance: `No other indexable page shares this ${field}.`,
    },
  });
  return rule;
}
const META004 = duplicateRule("META-004", "title", "verified", 3);
const META009 = duplicateRule("META-009", "description", "heuristic", 2);

const META005 = page({
  id: "META-005",
  version: 1,
  confidence: "heuristic",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    const t = p.titles[0];
    if (!isHtml200(p) || !t) return [];
    const px = titlePixels(t);
    return px > TITLE_MAX_PX ? [finding(META005, p.url, `Title is about ${px} px wide; results truncate around ${TITLE_MAX_PX} px.`, { title: t, px })] : [];
  },
  explain: { why: "Long titles are cut off in results (by pixel width, not characters).", fix: "Shorten the title and put the important words first.", acceptance: `Estimated width at most ${TITLE_MAX_PX} px.` },
});

const META006 = page({
  id: "META-006",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    const t = p.titles[0];
    return isHtml200(p) && t && t.length < TITLE_MIN_CHARS ? [finding(META006, p.url, `Title is ${t.length} characters.`, { title: t })] : [];
  },
  explain: { why: "Very short titles under-describe the page.", fix: "Expand the title with the page's specific topic.", acceptance: `At least ${TITLE_MIN_CHARS} characters.` },
});

const sameText = (a: string | null, b: string | null) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();

const META007 = site({
  id: "META-007",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["graph"],
  evaluate({ site: s }) {
    const out: Finding[] = [];
    const html = s.urls.filter((u) => u.statusCode === 200 && u.page);
    for (const [template, group] of groupBy(html, (u) => u.page!.template)) {
      if (group.length < TEMPLATE_MIN_PAGES || !group.every((u) => sameText(u.page!.title, u.page!.h1))) continue;
      for (const u of group) out.push(finding(META007, u.url, `Title equals the H1 on all ${group.length} pages of this template.`, { template, title: u.page!.title, pages: group.length }));
    }
    return out;
  },
  explain: { why: "A title that only repeats the H1 misses the chance to add context (brand, category, intent) in results.", fix: "Make the template build titles from more than the H1.", acceptance: "Titles on the template differ from their H1s." },
});

const META008 = page({
  id: "META-008",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate: ({ page: p }) => (isHtml200(p) && !p.descriptions.some((d) => d) ? [finding(META008, p.url, p.descriptions.length ? "Meta description is empty." : "No meta description.")] : []),
  explain: { why: "Without a description, search engines pick a snippet from the page, often a poor one.", fix: "Add a meta description summarising the page in one or two sentences.", acceptance: "A non-empty meta description." },
});

const META010 = page({
  id: "META-010",
  version: 1,
  confidence: "heuristic",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    const d = p.descriptions[0];
    if (!isHtml200(p) || !d) return [];
    const px = descriptionPixels(d);
    if (px > DESCRIPTION_MAX_PX) return [finding(META010, p.url, `Description is about ${px} px wide; results truncate around ${DESCRIPTION_MAX_PX} px.`, { description: d, px, reason: "long" })];
    if (d.length < DESCRIPTION_MIN_CHARS) return [finding(META010, p.url, `Description is ${d.length} characters.`, { description: d, reason: "short" })];
    return [];
  },
  explain: { why: "Long descriptions are cut off; very short ones say too little to earn the click.", fix: "Aim for one or two sentences that fit the snippet.", acceptance: `${DESCRIPTION_MIN_CHARS}+ characters and at most ${DESCRIPTION_MAX_PX} px.` },
});

const META011 = page({
  id: "META-011",
  version: 1,
  confidence: "verified",
  impact: 2,
  needs: ["raw"],
  evaluate: ({ page: p }) => (isHtml200(p) && !p.language?.declared ? [finding(META011, p.url, "<html> has no lang attribute.")] : []),
  explain: { why: "The lang attribute tells search engines and screen readers the page's language.", fix: 'Add lang to <html>, e.g. <html lang="en">.', acceptance: "<html> has a valid lang." },
});

/** Why a lang value is invalid, or null. BCP 47 syntax via Intl, and a 2–3 letter primary language subtag. */
export function langProblem(value: string): string | null {
  try {
    Intl.getCanonicalLocales(value);
  } catch {
    return "not a valid BCP 47 language tag";
  }
  return /^[a-z]{2,3}$/i.test(value.split("-")[0]) ? null : "primary language subtag is not a 2–3 letter code";
}

const META012 = page({
  id: "META-012",
  version: 1,
  confidence: "heuristic",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    const l = p.language;
    if (!isHtml200(p) || !l?.declared) return [];
    const problem = langProblem(l.declared);
    if (problem) return [finding(META012, p.url, `lang="${l.declared}" is invalid: ${problem}.`, { declared: l.declared, reason: "invalid" })];
    const primary = l.declared.split("-")[0].toLowerCase();
    if (l.detected && l.accuracy !== null && l.accuracy >= LANGUAGE_MIN_ACCURACY && p.wordCount >= LANGUAGE_MIN_WORDS && l.detected !== primary) {
      return [finding(META012, p.url, `lang="${l.declared}" but the text reads as "${l.detected}".`, { declared: l.declared, detected: l.detected, accuracy: l.accuracy, reason: "mismatch" })];
    }
    return [];
  },
  explain: { why: "A wrong lang value misleads search engines about which audience the page serves.", fix: "Set lang to the language the page is written in.", acceptance: "lang is valid and matches the detected language." },
});

const META013 = page({
  id: "META-013",
  version: 1,
  confidence: "verified",
  impact: 4,
  needs: ["raw"],
  evaluate: ({ page: p }) => (isHtml200(p) && p.facts && !p.facts.viewport.length ? [finding(META013, p.url, "No viewport meta tag.")] : []),
  explain: { why: "Without a viewport, mobile browsers render a desktop-width page; mobile-first indexing judges that page.", fix: 'Add <meta name="viewport" content="width=device-width, initial-scale=1">.', acceptance: "A viewport meta tag with width=device-width." },
});

/** Why a viewport disables zoom, or null. */
export function viewportBlocksZoom(content: string): string | null {
  const props = new Map(content.split(/[,;]/).map((kv) => kv.split("=").map((s) => s.trim().toLowerCase()) as [string, string]));
  const us = props.get("user-scalable");
  if (us === "no" || us === "0") return `user-scalable=${us}`;
  const max = Number(props.get("maximum-scale"));
  if (props.has("maximum-scale") && Number.isFinite(max) && max <= 1) return `maximum-scale=${props.get("maximum-scale")}`;
  return null;
}

const META014 = page({
  id: "META-014",
  version: 1,
  confidence: "verified",
  impact: 2,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || !p.facts) return [];
    for (const v of p.facts.viewport) {
      const why = viewportBlocksZoom(v);
      if (why) return [finding(META014, p.url, `Viewport disables zoom (${why}).`, { viewport: v })];
    }
    return [];
  },
  explain: { why: "Blocking zoom fails accessibility guidance and hurts mobile usability.", fix: "Remove user-scalable=no and any maximum-scale at or below 1.", acceptance: "The viewport allows zooming." },
});

/** HTML spec: a meta charset must be within the first 1024 bytes. */
export const CHARSET_MAX_OFFSET = 1024;
const META015 = page({
  id: "META-015",
  version: 1,
  confidence: "verified",
  impact: 1,
  needs: ["raw", "headers"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || !p.facts || p.facts.headerCharset) return [];
    const m = p.facts.metaCharset;
    if (!m) return [finding(META015, p.url, "No charset in the Content-Type header or a meta tag.", { reason: "missing" })];
    return m.offset > CHARSET_MAX_OFFSET ? [finding(META015, p.url, `Meta charset starts at byte ${m.offset}, after the first ${CHARSET_MAX_OFFSET}.`, { reason: "late", offset: m.offset })] : [];
  },
  explain: { why: "Without an early charset, browsers may guess the encoding and garble text.", fix: 'Put <meta charset="utf-8"> first in <head>, or send charset in Content-Type.', acceptance: "Charset declared in the header or in the first 1024 bytes." },
});

const META016 = page({
  id: "META-016",
  version: 1,
  confidence: "heuristic",
  impact: 1,
  needs: ["raw"],
  evaluate({ page: p }) {
    if (!isHtml200(p) || !p.facts) return [];
    const missing = (["title", "image", "url"] as const).filter((k) => !p.facts!.og[k]);
    return missing.length ? [finding(META016, p.url, `Missing Open Graph ${missing.map((k) => `og:${k}`).join(", ")}.`, { missing })] : [];
  },
  explain: { why: "Social and messaging apps build link previews from Open Graph tags.", fix: "Add og:title, og:image and og:url.", acceptance: "All three Open Graph tags are present." },
});

export const OG_IMAGE_MIN_PX = 200;
const META017 = site({
  id: "META-017",
  version: 1,
  confidence: "verified",
  impact: 1,
  needs: ["headers"],
  evaluate({ site: s, crawl }) {
    const probes = new Map(crawl.probes.filter((p) => p.kind === "og_image").map((p) => [p.url, p]));
    const out: Finding[] = [];
    for (const u of s.urls) {
      if (u.statusCode !== 200 || !u.page) continue;
      const img = resolveOgImage(u.page.ogImage, u.url);
      const pr = img ? probes.get(img) : undefined;
      if (!pr || pr.skipped) continue; // not probed: inconclusive
      if (pr.status !== 200) out.push(finding(META017, u.url, pr.error ? `og:image could not be fetched: ${pr.error.message}` : `og:image returns HTTP ${pr.status}.`, { image: img, status: pr.status, reason: "unreachable" }));
      else if (pr.width !== undefined && pr.height !== undefined && (pr.width < OG_IMAGE_MIN_PX || pr.height < OG_IMAGE_MIN_PX)) out.push(finding(META017, u.url, `og:image is ${pr.width}×${pr.height} px, under ${OG_IMAGE_MIN_PX} px.`, { image: img, width: pr.width, height: pr.height, reason: "small" }));
    }
    return out;
  },
  explain: { why: "Platforms drop previews whose image is missing or smaller than 200 px.", fix: "Point og:image at a reachable image of at least 1200×630.", acceptance: "og:image returns 200 and is at least 200 px on each side." },
});

const META018 = page({
  id: "META-018",
  version: 1,
  confidence: "advisory",
  impact: 1,
  needs: ["raw"],
  evaluate: ({ page: p }) => (isHtml200(p) && p.facts && !p.facts.twitterCard ? [finding(META018, p.url, "No twitter:card meta tag.")] : []),
  explain: { why: "X uses twitter:card to choose the preview layout; without it, a plain link may show.", fix: 'Add <meta name="twitter:card" content="summary_large_image">.', acceptance: "twitter:card is present." },
});

const META019 = site({
  id: "META-019",
  version: 1,
  confidence: "verified",
  impact: 1,
  needs: ["headers"],
  evaluate({ site: s, crawl }) {
    const probe = crawl.probes.find((p) => p.kind === "favicon");
    const home: UrlFacts | undefined = s.byUrl.get(homeUrl(crawl.origin));
    if (!probe || probe.skipped || probe.status === 200) return [];
    return [finding(META019, home?.url ?? homeUrl(crawl.origin), probe.error ? `Favicon could not be fetched: ${probe.error.message}` : `Favicon ${probe.url} returns HTTP ${probe.status}.`, { favicon: probe.url, status: probe.status })];
  },
  explain: { why: "Search results and browser tabs show the favicon; a missing one looks unfinished.", fix: 'Serve /favicon.ico or declare an icon with <link rel="icon">.', acceptance: "The site's favicon returns 200." },
});

export const META_RULES = [META001, META002, META003, META004, META005, META006, META007, META008, META009, META010, META011, META012, META013, META014, META015, META016, META017, META018, META019];
