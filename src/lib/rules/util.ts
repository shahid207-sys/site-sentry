// Small helpers shared by catalog rules.
import type { PageView, UrlFacts } from "./contract";

/** An HTML page that returned 200: the pages metadata and content rules judge. */
export const isHtml200 = (p: PageView) => p.html && p.statusCode === 200;

/** Directives that apply to every crawler (meta robots and unprefixed X-Robots-Tag), by source. */
export function generalDirectives(p: PageView, source: "meta" | "header"): string[] {
  return (p.robots?.directives ?? []).filter((d) => d.source === source && (d.agent === "robots" || d.agent === "*")).flatMap((d) => d.directives);
}

/** Group by a key, dropping null keys. */
export function groupBy<T>(xs: T[], key: (x: T) => string | null): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const k = key(x);
    if (k === null) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(x);
  }
  return m;
}

/** Up to `n` other URLs from a group, for evidence. */
export const others = (group: UrlFacts[], self: UrlFacts, n = 10) => group.filter((g) => g !== self).slice(0, n).map((g) => g.url);

/**
 * A URL for machines, not readers: WordPress's REST API (/wp-json/, ?rest_route=), XML-RPC, admin-ajax, oEmbed and
 * RSS/Atom feeds. A noindex there is correct, so the indexability rules do not judge them.
 */
export function isMachineEndpoint(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const path = u.pathname.toLowerCase();
  return (
    /(^|\/)wp-json(\/|$)/.test(path) ||
    /\/(xmlrpc|wp-admin\/admin-ajax)\.php$/.test(path) ||
    /(^|\/)oembed(\/|$)/.test(path) ||
    /(^|\/)(feed|rss|atom)(\/(rss2?|atom|rdf))?\/?$/.test(path) ||
    /\.(rss|atom)$/.test(path) ||
    u.searchParams.has("rest_route") ||
    /^(rss2?|atom|rdf)$/.test(u.searchParams.get("feed") ?? "")
  );
}

export const robotsUrl = (origin: string) => new URL("/robots.txt", origin).toString();
export const homeUrl = (origin: string) => new URL("/", origin).toString();

/** Common English words that carry no topic, for term comparisons. Two-letter words count as terms (AI, UX, HR), so
 * the two-letter function words are listed too. */
export const STOPWORDS = new Set(
  "a an and are as at be by for from has have how in is it its of on or our that the this to was were what when where which who why will with you your about into over more most new best top guide page site home welcome am do go he if me my no so up us we vs ok".split(" "),
);

/** A light stem so word forms match: "designing"/"design", "pays"/"pay", "scaling"/"scale". Not a full stemmer. */
export function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) w = w.slice(0, -3);
  else if (w.length > 4 && w.endsWith("ed")) w = w.slice(0, -2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0, -1);
  return w.length > 3 && w.endsWith("e") ? w.slice(0, -1) : w;
}

/** Meaningful terms of a short text: lower-cased words of 2+ characters, not stopwords, stemmed. */
export function meaningfulTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 2 || STOPWORDS.has(w)) continue;
    out.add(stem(w));
  }
  return out;
}
