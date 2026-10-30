// Pure numbers of the Architecture screen (no React): the crawl-depth histogram, the directory breakdown computed
// from the URL rows, the internal PageRank leaderboard and the deep / unreachable pages. Every figure is derived from
// the API's own fields (/structure and /urls); nothing is estimated.
import type { UrlRow } from "@/lib/results/explore";
import { ANSWERED } from "../overview/model";
import { READ_STATES, REGEX_MAX } from "../urls/filter";

/** Copy of MAX_CLICK_DEPTH in src/lib/rules/lnk.ts (LNK-004 "Page deeper than 4 clicks"). Keep them in step. */
export const MAX_CLICK_DEPTH = 4;

const ANSWERED_SET = new Set(ANSWERED);
export const isAnswered = (state: string) => ANSWERED_SET.has(state);

/** A URL the crawler fetched and read as an HTML page (the pages link depth, inbound and PageRank describe). */
export const isHtmlPage = (r: Pick<UrlRow, "state" | "contentType">) => READ_STATES.has(r.state) && /html/i.test(r.contentType ?? "");

// ---------- depth histogram ----------

export interface DepthBar {
  /** null: found only in sitemaps (no link path from a seed). */
  depth: number | null;
  label: string;
  urls: number;
  answered: number;
  notAnswered: number;
}

/**
 * One bar per link depth from 0 to the deepest, gaps filled with zero bars so the axis is honest, then the
 * "only in sitemaps" bar (depth null) last when it has URLs. Duplicate depths are summed.
 */
export function depthBars(rows: { depth: number | null; urls: number; answered: number }[]): DepthBar[] {
  const byDepth = new Map<number, { urls: number; answered: number }>();
  let sitemap = { urls: 0, answered: 0 };
  for (const r of rows) {
    if (r.depth === null) sitemap = { urls: sitemap.urls + r.urls, answered: sitemap.answered + r.answered };
    else {
      const c = byDepth.get(r.depth) ?? { urls: 0, answered: 0 };
      byDepth.set(r.depth, { urls: c.urls + r.urls, answered: c.answered + r.answered });
    }
  }
  const out: DepthBar[] = [];
  if (byDepth.size) {
    const max = Math.max(...byDepth.keys());
    for (let d = 0; d <= max; d++) {
      const c = byDepth.get(d) ?? { urls: 0, answered: 0 };
      out.push({ depth: d, label: String(d), urls: c.urls, answered: c.answered, notAnswered: Math.max(0, c.urls - c.answered) });
    }
  }
  if (sitemap.urls > 0) out.push({ depth: null, label: "Sitemaps only", urls: sitemap.urls, answered: sitemap.answered, notAnswered: Math.max(0, sitemap.urls - sitemap.answered) });
  return out;
}

// ---------- directories ----------

/** Host (lower-cased, with port) and path of an absolute URL, read from the string itself so it matches the URL filter. */
export function splitUrl(url: string): { host: string; path: string } | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)([^?#]*)/i.exec(url);
  if (!m) return null;
  return { host: m[1].toLowerCase(), path: m[2] || "/" };
}

/**
 * The first-level folder of a path: "/blog/" for /blog/, /blog/post and /blog/a/b; "/" for the home page and every
 * page directly under it (/about, /contact.html), which are pages in the root folder, not folders of their own.
 * Query strings never reach it (splitUrl drops them).
 */
export function directoryOf(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const i = p.indexOf("/", 1);
  return i === -1 ? "/" : p.slice(0, i + 1);
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The URL explorer filter (its `q` parameter) that shows exactly one folder's URLs: a case-insensitive regex anchored
 * at the site's host. Falls back to a plain substring (exact: false, it may over-match) when the regex would exceed the
 * explorer's REGEX_MAX.
 */
export function directoryFilter(host: string, dir: string): { q: string; exact: boolean } {
  const h = escapeRe(host);
  const pattern = dir === "/" ? `^https?://${h}(?:/[^/?#]*)?(?:[?#]|$)` : `^https?://${h}${escapeRe(dir)}`;
  if (pattern.length <= REGEX_MAX) return { q: `re:${pattern}`, exact: true };
  return { q: `${host}${dir}`, exact: false };
}

export interface DirectoryRow {
  /** "/" or "/folder/" (as first seen; folders that differ only by case are one row, as the explorer filter is case-insensitive). */
  dir: string;
  urls: number;
  answered: number;
  openIssues: number;
  /** Open issues ÷ URLs in the folder. */
  issuesPerUrl: number;
  /** Mean main-content words over the folder's pages that have a page snapshot; null when none has one. */
  avgWords: number | null;
  /** Mean inbound internal links over the folder's URLs that the site pass measured; null when none was. */
  avgInbound: number | null;
  /** URL explorer filter for the folder. */
  q: string;
  exactFilter: boolean;
}

/**
 * URLs per first-level folder of the site's own host. URLs on other hosts (out of scope, external redirects) are
 * not in any folder; they are counted in `otherHosts`.
 */
export function directoryBreakdown(rows: UrlRow[], siteHost: string): { rows: DirectoryRow[]; otherHosts: number } {
  const host = siteHost.toLowerCase();
  const acc = new Map<string, { dir: string; urls: number; answered: number; open: number; words: number; wordsN: number; inbound: number; inboundN: number }>();
  let otherHosts = 0;
  for (const r of rows) {
    const u = splitUrl(r.url);
    if (!u || u.host !== host) {
      otherHosts++;
      continue;
    }
    const dir = directoryOf(u.path);
    const key = dir.toLowerCase();
    let a = acc.get(key);
    if (!a) {
      a = { dir, urls: 0, answered: 0, open: 0, words: 0, wordsN: 0, inbound: 0, inboundN: 0 };
      acc.set(key, a);
    }
    a.urls++;
    if (isAnswered(r.state)) a.answered++;
    a.open += r.openIssues;
    if (r.wordCount !== null) {
      a.words += r.wordCount;
      a.wordsN++;
    }
    if (r.inbound !== null) {
      a.inbound += r.inbound;
      a.inboundN++;
    }
  }
  const out: DirectoryRow[] = [...acc.values()].map((a) => {
    const f = directoryFilter(host, a.dir);
    return {
      dir: a.dir,
      urls: a.urls,
      answered: a.answered,
      openIssues: a.open,
      issuesPerUrl: a.urls ? a.open / a.urls : 0,
      avgWords: a.wordsN ? a.words / a.wordsN : null,
      avgInbound: a.inboundN ? a.inbound / a.inboundN : null,
      q: f.q,
      exactFilter: f.exact,
    };
  });
  out.sort((a, b) => b.urls - a.urls || (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0));
  return { rows: out, otherHosts };
}

/** Sort key of a directory table column (see VirtualTable sortRows). */
export function directorySortKey(r: DirectoryRow, id: string): string | number | null {
  switch (id) {
    case "dir":
      return r.dir.toLowerCase();
    case "urls":
      return r.urls;
    case "answered":
      return r.answered;
    case "openIssues":
      return r.openIssues;
    case "issuesPerUrl":
      return r.issuesPerUrl;
    case "avgWords":
      return r.avgWords;
    case "avgInbound":
      return r.avgInbound;
    default:
      return null;
  }
}

// ---------- PageRank, deep and unreachable pages ----------

/** The `n` URLs with the highest internal PageRank (ties: more inbound links, then URL). URLs without a score are left out. */
export function pagerankLeaders(rows: UrlRow[], n = 50): UrlRow[] {
  return rows
    .filter((r) => r.pagerank !== null)
    .sort((a, b) => b.pagerank! - a.pagerank! || (b.inbound ?? -1) - (a.inbound ?? -1) || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))
    .slice(0, n);
}

export interface DepthProblems {
  /** HTML pages the crawler read. */
  pages: number;
  /** Of those, more than MAX_CLICK_DEPTH clicks from the start page, deepest first. */
  deep: UrlRow[];
  /** Of those, with no link path from the start page (link depth unknown after the site pass). */
  unreachable: UrlRow[];
}

/** Deep and link-unreachable HTML pages, from the site pass's link depth. Only meaningful once the audit is analysed. */
export function depthProblems(rows: UrlRow[], maxDepth = MAX_CLICK_DEPTH): DepthProblems {
  let pages = 0;
  const deep: UrlRow[] = [];
  const unreachable: UrlRow[] = [];
  for (const r of rows) {
    if (!isHtmlPage(r)) continue;
    pages++;
    if (r.linkDepth === null) unreachable.push(r);
    else if (r.linkDepth > maxDepth) deep.push(r);
  }
  deep.sort((a, b) => b.linkDepth! - a.linkDepth! || (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  unreachable.sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return { pages, deep, unreachable };
}
