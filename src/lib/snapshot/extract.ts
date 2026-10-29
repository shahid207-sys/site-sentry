// HTML → snapshot fields. Pure: no network, no clock. Runs in the crawl worker on the document it already parsed
// for outlinks, so each page is parsed once. Main-content text reuses the legacy content rule's extraction.
import { detect } from "tinyld";
import { blockText, BOILERPLATE, mainContentSource, mainContentText } from "../audit/rules/content";
import type { Doc } from "../audit/parse";
import type { Outlink } from "../crawl/v2/discovery";
import { templateShape } from "./template";
import { simhash, textHash, words } from "./text";
import type { CanonicalTag, ExtractedHtml, HeadingEntry, HeadTag, JsonLdBlock, PageFacts, RobotsDirective, RobotsSnapshot, SnapshotImage } from "./types";

/** Caps that keep one hostile page from bloating its snapshot row. */
export const SNAPSHOT_CAPS = { headTags: 300, headings: 500, images: 1000, jsonLdChars: 100_000, mainTextChars: 100_000, attrChars: 500 } as const;
/** Language detection runs only on at least this much main-content text. */
export const LANGUAGE_MIN_CHARS = 200;
/** tinyld is built for short strings: on a whole long page its scores spread across languages (a plain English page
 * came out "la" 0.33, "en" third). So it judges sentence-sized chunks of at least this many characters and votes. */
export const LANGUAGE_CHUNK_CHARS = 80;
/** Only this much main text is judged, which bounds the time per page. */
const LANGUAGE_MAX_CHARS = 20_000;

type El = Parameters<Doc>[0];
const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const tokens = (v: string | undefined) => (v ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
const attrsOf = (el: El): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries((el as { attribs?: Record<string, string> }).attribs ?? {})) out[k] = v.slice(0, SNAPSHOT_CAPS.attrChars);
  return out;
};

function resolve(href: string | undefined, base: string): string | null {
  if (href === undefined) return null;
  try {
    const u = new URL(href.trim(), base);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Directives a value carries, split by the user-agent prefixes X-Robots-Tag allows ("googlebot: noindex"). */
const VALUE_DIRECTIVES = new Set(["max-snippet", "max-image-preview", "max-video-preview", "unavailable_after"]);
export function parseRobotsHeader(value: string): RobotsDirective[] {
  const groups = new Map<string, string[]>();
  let agent = "*";
  for (const raw of value.split(",")) {
    const part = raw.trim().toLowerCase();
    if (!part) continue;
    const m = /^([a-z0-9_-]+)\s*:\s*(.*)$/.exec(part);
    let directive = part;
    if (m && !VALUE_DIRECTIVES.has(m[1])) {
      agent = m[1];
      directive = m[2].trim();
    }
    if (!directive) continue;
    if (!groups.has(agent)) groups.set(agent, []);
    groups.get(agent)!.push(directive);
  }
  return [...groups].map(([a, directives]) => ({ source: "header" as const, agent: a, directives }));
}

function robotsOf($: Doc, headers: Record<string, string>): RobotsSnapshot {
  const directives: RobotsDirective[] = [];
  $("meta[name]").each((_, el) => {
    const name = ($(el).attr("name") ?? "").trim().toLowerCase();
    if (name === "robots" || name.endsWith("bot")) directives.push({ source: "meta", agent: name, directives: tokens($(el).attr("content")) });
  });
  if (headers["x-robots-tag"]) directives.push(...parseRobotsHeader(headers["x-robots-tag"]));
  const general = (source: "meta" | "header") => directives.filter((d) => d.source === source && (d.agent === "robots" || d.agent === "*")).flatMap((d) => d.directives);
  const has = (list: string[], t: string) => list.includes(t) || list.includes("none");
  const meta = general("meta");
  const header = general("header");
  return { directives, noindex: { meta: has(meta, "noindex"), header: has(header, "noindex") }, nofollow: { meta: has(meta, "nofollow"), header: has(header, "nofollow") } };
}

function canonicalsOf($: Doc, base: string, headers: Record<string, string>): CanonicalTag[] {
  const out: CanonicalTag[] = [];
  $("link[rel]").each((_, el) => {
    if (!tokens($(el).attr("rel")).includes("canonical")) return;
    const href = $(el).attr("href") ?? "";
    out.push({ href, resolved: href.trim() ? resolve(href, base) : null, location: $(el).closest("head").length ? "head" : "body", absolute: /^https?:\/\//i.test(href.trim()) });
  });
  // Link: <https://a.test/x>; rel="canonical"
  for (const m of (headers.link ?? "").matchAll(/<([^>]*)>\s*;[^,]*rel\s*=\s*"?([^",;]*)"?/gi)) {
    if (tokens(m[2]).includes("canonical")) out.push({ href: m[1], resolved: resolve(m[1], base), location: "header", absolute: /^https?:\/\//i.test(m[1].trim()) });
  }
  return out;
}

const JS_REDIRECT = [
  /\b(?:window\.|document\.|self\.|top\.)?location(?:\.href)?\s*=\s*(["'`])([^"'`]+)\1/,
  /\blocation\.(?:replace|assign)\(\s*(["'`])([^"'`]+)\1\s*\)/,
];

function factsOf($: Doc, html: string, base: string, headers: Record<string, string>, mainTextChars: number, htmlBytes: number): PageFacts {
  const metaContent = (pred: (name: string) => boolean) =>
    $("meta")
      .toArray()
      .filter((el) => pred((($(el).attr("name") ?? $(el).attr("property")) ?? "").trim().toLowerCase()))
      .map((el) => collapse($(el).attr("content") ?? ""));
  const first = (name: string) => metaContent((n) => n === name)[0] ?? null;

  const cm = /<meta\s[^>]*?charset\s*=\s*["']?\s*([\w.:-]+)/i.exec(html);
  const metaCharset = cm ? { value: cm[1].toLowerCase(), offset: Buffer.byteLength(html.slice(0, cm.index)) } : null;
  const hc = /charset\s*=\s*"?([\w.:-]+)/i.exec(headers["content-type"] ?? "");

  let metaRefresh: PageFacts["metaRefresh"] = null;
  $("meta[http-equiv]").each((_, el) => {
    if (metaRefresh || ($(el).attr("http-equiv") ?? "").trim().toLowerCase() !== "refresh") return;
    const content = $(el).attr("content") ?? "";
    const t = /url\s*=\s*['"]?([^'";]+)/i.exec(content);
    metaRefresh = { content: content.slice(0, 500), target: t ? resolve(t[1], base) : null };
  });

  let jsRedirect: string | null = null;
  $("script:not([src])").each((_, el) => {
    if (jsRedirect) return;
    const code = $(el).text();
    for (const re of JS_REDIRECT) {
      const m = re.exec(code);
      if (m) {
        jsRedirect = resolve(m[2], base) ?? m[2];
        return;
      }
    }
  });

  const renderResources: string[] = [];
  $("link[rel][href]").each((_, el) => {
    if (tokens($(el).attr("rel")).includes("stylesheet")) {
      const r = resolve($(el).attr("href"), base);
      if (r) renderResources.push(r);
    }
  });
  $("script[src]").each((_, el) => {
    const r = resolve($(el).attr("src"), base);
    if (r) renderResources.push(r);
  });

  const icons: string[] = [];
  $("link[rel][href]").each((_, el) => {
    if (!tokens($(el).attr("rel")).includes("icon")) return;
    const r = resolve($(el).attr("href"), base);
    if (r) icons.push(r);
  });

  const videos: NonNullable<PageFacts["videos"]> = [];
  $("video").each((_, el) => {
    const n = $(el);
    const src = n.attr("src") ?? n.children("source[src]").first().attr("src");
    videos.push({ src: src ? resolve(src, base) : null, poster: n.attr("poster") ? resolve(n.attr("poster"), base) : null });
  });

  const body = $("body").first().clone();
  body.find("script, style, noscript, template, svg").remove();

  return {
    metaCharset,
    headerCharset: hc ? hc[1].toLowerCase() : null,
    viewport: metaContent((n) => n === "viewport"),
    og: { title: first("og:title"), image: first("og:image"), url: first("og:url") },
    twitterCard: first("twitter:card"),
    icons,
    metaRefresh,
    jsRedirect,
    renderResources: [...new Set(renderResources)],
    videos: videos.slice(0, 100),
    bodyTextChars: blockText(body).length,
    mainTextChars,
    htmlBytes,
  };
}

/** Sentences, joined until each chunk has at least LANGUAGE_CHUNK_CHARS characters. */
function languageChunks(text: string): string[] {
  const out: string[] = [];
  let cur = "";
  // Tokens with no language mislead the detector: acronyms ("SEO" reads as Irish) and paths, URLs and numbers (a list
  // of "/content/p-12" link labels), so they are dropped.
  const judged = text.slice(0, LANGUAGE_MAX_CHARS).replace(/\S*[/\d@]\S*/g, " ").replace(/\b\p{Lu}{2,}s?\b/gu, " ").replace(/ {2,}/g, " ");
  for (const s of judged.split(/(?<=[.!?。！？])\s+/)) {
    cur = cur ? `${cur} ${s}` : s;
    if (cur.length < LANGUAGE_CHUNK_CHARS) continue;
    out.push(cur);
    cur = "";
  }
  if (cur.length >= LANGUAGE_CHUNK_CHARS / 2 || !out.length) out.push(cur);
  return out;
}

/**
 * Detected language: the language tinyld gives most chunks, weighted by length. Accuracy is that language's share of
 * the judged text, so a page that is half one language and half another reads about 0.5, never "sure".
 */
function language(declared: string | null, text: string): ExtractedHtml["language"] {
  if (text.length < LANGUAGE_MIN_CHARS) return { declared, detected: null, accuracy: null };
  const votes = new Map<string, number>();
  let total = 0;
  for (const chunk of languageChunks(text)) {
    total += chunk.length;
    const lang = detect(chunk);
    if (lang) votes.set(lang, (votes.get(lang) ?? 0) + chunk.length);
  }
  const [top] = [...votes].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return { declared, detected: top?.[0] ?? null, accuracy: top ? Math.round((top[1] / total) * 1000) / 1000 : null };
}

export interface ExtractInput {
  $: Doc;
  html: string;
  /** URL the document was served from; relative references resolve against it (or its <base href>). */
  pageUrl: string;
  headers: Record<string, string>;
  bytes: number;
  outlinks: Outlink[];
}

export function extractHtml({ $, html, pageUrl, headers, bytes, outlinks }: ExtractInput): ExtractedHtml {
  const base = resolve($("base[href]").first().attr("href"), pageUrl) ?? pageUrl;

  const head: HeadTag[] = [];
  $("head")
    .children()
    .each((_, el) => {
      if (head.length >= SNAPSHOT_CAPS.headTags) return false;
      const tag = (el as { tagName?: string }).tagName?.toLowerCase() ?? "";
      head.push({ tag, attrs: attrsOf(el), ...(tag === "title" ? { text: collapse($(el).text()).slice(0, 1000) } : {}) });
    });

  // <title> inside inline SVG/MathML is element-level metadata, not the document title (legacy title rule).
  const titles = $("title")
    .filter((_, el) => $(el).parents("svg, math").length === 0)
    .toArray()
    .map((el) => collapse($(el).text()));
  const descriptions = $("meta[name]")
    .toArray()
    .filter((el) => ($(el).attr("name") ?? "").trim().toLowerCase() === "description")
    .map((el) => collapse($(el).attr("content") ?? ""));

  const outline: HeadingEntry[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    if (outline.length >= SNAPSHOT_CAPS.headings) return false;
    const level = Number((el as { tagName: string }).tagName.slice(1)) as HeadingEntry["level"];
    // Block boundaries and <br> read as spaces: "Ask AI<br>Who" is "Ask AI Who", not "AIWho".
    outline.push({ level, text: blockText($(el).clone()).slice(0, 300) });
  });

  const main = mainContentText($).text.slice(0, SNAPSHOT_CAPS.mainTextChars);

  // An image is in the main content when it sits inside the element mainContentText reads and outside boilerplate.
  const source = mainContentSource($);
  const mainRoot = $(source === "main" ? "main, [role=main]" : source).first()[0];
  const fillsParent = (style: string | undefined) => {
    const s = (style ?? "").toLowerCase().replace(/\s+/g, "");
    return /(^|;)position:(absolute|fixed)/.test(s) && (/(^|;)inset:0(px)?(;|$)/.test(s) || (/(^|;)width:100%/.test(s) && /(^|;)height:100%/.test(s)));
  };
  const images: SnapshotImage[] = [];
  $("img").each((_, el) => {
    if (images.length >= SNAPSHOT_CAPS.images) return false;
    const n = $(el);
    const src = n.attr("src") ?? "";
    images.push({
      src,
      resolved: src ? resolve(src, base) : null,
      alt: n.attr("alt") ?? null,
      width: n.attr("width") ?? null,
      height: n.attr("height") ?? null,
      loading: n.attr("loading") ?? null,
      srcset: n.attr("srcset") ?? null,
      linked: n.closest("a[href]").length > 0,
      inMain: !!mainRoot && n.parents().toArray().includes(mainRoot) && !n.closest(BOILERPLATE).length,
      inPicture: n.parent().is("picture") && n.parent().children("source[srcset]").length > 0,
      fillsParent: fillsParent(n.attr("style")),
    });
  });

  const jsonLd: JsonLdBlock[] = [];
  $("script[type]").each((_, el) => {
    if (($(el).attr("type") ?? "").trim().toLowerCase() !== "application/ld+json") return;
    const raw = $(el).text().slice(0, SNAPSHOT_CAPS.jsonLdChars);
    try {
      jsonLd.push({ raw, parsed: JSON.parse(raw), error: null });
    } catch (e) {
      jsonLd.push({ raw, parsed: null, error: (e as Error).message });
    }
  });

  const shape = templateShape($);
  return {
    head,
    canonicals: canonicalsOf($, base, headers),
    robots: robotsOf($, headers),
    titles,
    descriptions,
    outline,
    mainText: main,
    wordCount: words(main).length,
    language: language($("html").attr("lang")?.trim() ?? null, main),
    links: outlinks.map((l) => ({ href: l.url, original: l.original, via: l.via, anchor: l.anchor, rel: l.rel, location: l.location, nofollow: l.nofollow, ...(l.hreflang ? { hreflang: l.hreflang } : {}) })),
    images,
    jsonLd,
    textHash: textHash(main),
    simhash: simhash(main),
    templateFingerprint: shape?.fingerprint ?? null,
    templateShape: shape?.shape ?? null,
    facts: factsOf($, html, base, headers, main.length, bytes),
  };
}
