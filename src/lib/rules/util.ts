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

export const robotsUrl = (origin: string) => new URL("/robots.txt", origin).toString();
export const homeUrl = (origin: string) => new URL("/", origin).toString();

/** Common English words that carry no topic, for term comparisons. */
export const STOPWORDS = new Set(
  "a an and are as at be by for from has have how in is it its of on or our that the this to was were what when where which who why will with you your about into over more most new best top guide page site home welcome".split(" "),
);

/** Meaningful terms of a short text: lower-cased words of 3+ letters, not stopwords, with a plural "s" dropped. */
export function meaningfulTerms(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (w.length < 3 || STOPWORDS.has(w)) continue;
    out.add(w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
  }
  return out;
}
