// Discovery for crawler v2 (docs/SPEC.md "Crawler engine → Discovery sources"). Storage-agnostic:
// sitemap traversal yields URL batches for the caller to persist; outlink extraction is pure.
import type { Doc } from "../../audit/parse";
import type { Fetcher } from "../../fetch/safe-fetch";
import { SafeFetchError } from "../../fetch/safe-fetch";
import { normaliseUrl, type NormaliseFailure, type NormaliseOptions } from "../normalise";
import { SITEMAP_DISCOVERY } from "../profiles";
import { parseSitemap, SITEMAP_PROTOCOL_MAX_URLS } from "../sitemap";
import type { DiscoverySource, LinkLocation } from "./types";

// ---------- sitemaps ----------

/** Spec: recurse sitemap indexes to depth 3. Depth 0 = a sitemap named by robots.txt or a default location. */
export const MAX_SITEMAP_INDEX_DEPTH = SITEMAP_DISCOVERY.maxIndexDepth;
/** Upper bound on sitemap documents read per crawl, so a hostile index cannot fan out without limit. */
export const MAX_SITEMAP_DOCS = SITEMAP_DISCOVERY.maxDocs;
export const DEFAULT_SITEMAP_PATHS = ["/sitemap.xml", "/sitemap_index.xml"];

export interface SitemapDocRecord {
  url: string;
  /** How this sitemap document was found. */
  via: "robots" | "default" | "index" | "config";
  parent: string | null;
  depth: number;
  status: number | null;
  kind: "urlset" | "sitemapindex" | "unknown" | null;
  urlCount: number;
  errors: string[];
  truncated: boolean;
  error?: { code: string; message: string };
  /** Set when the document was listed but deliberately not read; the reason says why. */
  skipped?: "max_index_depth" | "max_docs";
  /** For a sitemap index: its child sitemap URLs, normalised. Lets an interrupted discovery resume without re-reading it. */
  children?: string[];
  /** For a urlset: <lastmod> statistics (IDX-031). Dates are compared as written, ISO 8601 per sitemaps.org. */
  lastmod?: LastmodStats;
}

export interface LastmodStats {
  /** Entries with a <lastmod>. */
  count: number;
  distinct: number;
  /** Latest and earliest value, by parsed time; null when none parse. */
  max: string | null;
  min: string | null;
  /** Values that do not parse as dates. */
  invalid: number;
}

export function lastmodStats(values: string[]): LastmodStats {
  let max: [number, string] | null = null;
  let min: [number, string] | null = null;
  let invalid = 0;
  for (const v of values) {
    const t = Date.parse(v);
    if (Number.isNaN(t)) {
      invalid++;
      continue;
    }
    if (!max || t > max[0]) max = [t, v];
    if (!min || t < min[0]) min = [t, v];
  }
  return { count: values.length, distinct: new Set(values).size, max: max?.[1] ?? null, min: min?.[1] ?? null, invalid };
}

/** What an interrupted discovery run had done: documents it started fetching, and documents it finished. */
export interface SitemapProgress {
  started: string[];
  docs: SitemapDocRecord[];
}

export interface DiscoveredUrl {
  url: string;
  original: string;
}

export interface RejectedUrl {
  original: string;
  reason: NormaliseFailure;
}

export type SitemapEvent =
  /** About to request this document. Persist it before pulling the next event, so a resumed run never re-requests it. */
  | { type: "start"; url: string }
  | { type: "doc"; doc: SitemapDocRecord }
  | { type: "urls"; sitemap: string; urls: DiscoveredUrl[]; rejected: RejectedUrl[] };

export interface SitemapDiscoveryInput {
  origin: string;
  /** `Sitemap:` lines from robots.txt, in file order. */
  robotsSitemaps: string[];
  /** Extra sitemap URLs from the crawl config. */
  configured?: string[];
  fetch: Fetcher;
  normalise?: NormaliseOptions;
  maxIndexDepth?: number;
  maxDocs?: number;
  /** URLs per yielded batch. */
  batchSize?: number;
  /** Progress of an earlier, interrupted run over the same site. */
  prior?: SitemapProgress;
}

const errOf = (e: unknown) => (e instanceof SafeFetchError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: (e as Error)?.message ?? "error" });

/**
 * Breadth-first over sitemap documents: robots.txt declarations, configured sitemaps, then /sitemap.xml and
 * /sitemap_index.xml. Gzipped documents are decompressed by the fetcher. Each document is read once; every
 * document (read, failed or skipped) is reported, so the coverage report can say what was and was not read.
 *
 * Resumable at most once per document: a `start` event precedes every request, and a urlset's `doc` event follows
 * its URL batches. With `prior`, finished documents are replayed from their records without a request, and a
 * document that was started but never finished is reported as interrupted instead of being requested again.
 */
export async function* discoverSitemaps(input: SitemapDiscoveryInput): AsyncGenerator<SitemapEvent> {
  const maxDepth = input.maxIndexDepth ?? MAX_SITEMAP_INDEX_DEPTH;
  const maxDocs = input.maxDocs ?? MAX_SITEMAP_DOCS;
  const batchSize = input.batchSize ?? 500;
  const queue: { url: string; via: SitemapDocRecord["via"]; parent: string | null; depth: number }[] = [];
  const seen = new Set<string>();
  const enqueue = (raw: string, via: SitemapDocRecord["via"], parent: string | null, depth: number) => {
    const n = normaliseUrl(raw, { base: parent ?? input.origin, dropParams: [] });
    if (!n.ok || seen.has(n.url)) return;
    seen.add(n.url);
    queue.push({ url: n.url, via, parent, depth });
  };
  for (const s of input.robotsSitemaps) enqueue(s, "robots", null, 0);
  for (const s of input.configured ?? []) enqueue(s, "config", null, 0);
  for (const p of DEFAULT_SITEMAP_PATHS) enqueue(new URL(p, input.origin).toString(), "default", null, 0);

  const priorDocs = new Map((input.prior?.docs ?? []).map((d) => [d.url, d]));
  const priorStarted = new Set(input.prior?.started ?? []);

  function* children(item: (typeof queue)[number], urls: string[]): Generator<SitemapEvent> {
    for (const url of urls) {
      if (item.depth + 1 > maxDepth) {
        if (!seen.has(url)) {
          seen.add(url);
          if (!priorDocs.has(url)) {
            yield { type: "doc", doc: { url, via: "index", parent: item.url, depth: item.depth + 1, status: null, kind: null, urlCount: 0, errors: [], truncated: false, skipped: "max_index_depth" } };
          }
        }
        continue;
      }
      enqueue(url, "index", item.url, item.depth + 1);
    }
  }

  let read = 0;
  while (queue.length) {
    const item = queue.shift()!;
    const doc: SitemapDocRecord = { ...item, status: null, kind: null, urlCount: 0, errors: [], truncated: false };
    const before = priorDocs.get(item.url);
    if (before) {
      // Finished in the earlier run: its URLs are already stored; only an index's children need replaying.
      if (!before.skipped) read++;
      if (before.children) yield* children(item, before.children);
      continue;
    }
    if (read >= maxDocs) {
      yield { type: "doc", doc: { ...doc, skipped: "max_docs" } };
      continue;
    }
    read++;
    if (priorStarted.has(item.url)) {
      yield { type: "doc", doc: { ...doc, error: { code: "INTERRUPTED", message: "The worker stopped while reading this sitemap; not requested again (at-most-once)." } } };
      continue;
    }
    yield { type: "start", url: item.url };
    let body: string | null = null;
    try {
      const res = await input.fetch(item.url, { accept: "sitemap" });
      doc.status = res.status;
      doc.truncated = res.truncated;
      if (res.status >= 200 && res.status < 300 && res.contentTypeAccepted) body = res.body;
    } catch (e) {
      doc.error = errOf(e);
    }
    if (body === null) {
      yield { type: "doc", doc };
      continue;
    }
    const parsed = parseSitemap(body, SITEMAP_PROTOCOL_MAX_URLS);
    doc.kind = parsed.kind;
    doc.errors = parsed.errors;
    doc.truncated ||= parsed.truncated;
    doc.urlCount = parsed.locs.length;
    if (parsed.kind === "urlset") doc.lastmod = lastmodStats(parsed.lastmods);

    if (parsed.kind === "sitemapindex") {
      const kids = new Set<string>();
      for (const child of parsed.locs) {
        const n = normaliseUrl(child, { base: item.url, dropParams: [] });
        if (n.ok) kids.add(n.url);
      }
      doc.children = [...kids];
      // Record the index (with its children) before reading any child, so a resume can rebuild the queue.
      yield { type: "doc", doc };
      yield* children(item, doc.children);
      continue;
    }
    if (parsed.kind !== "urlset") {
      yield { type: "doc", doc };
      continue;
    }
    for (let i = 0; i < parsed.locs.length; i += batchSize) {
      const urls: DiscoveredUrl[] = [];
      const rejected: RejectedUrl[] = [];
      for (const loc of parsed.locs.slice(i, i + batchSize)) {
        const n = normaliseUrl(loc, input.normalise);
        if (n.ok) urls.push({ url: n.url, original: loc });
        else rejected.push({ original: loc, reason: n.reason });
      }
      yield { type: "urls", sitemap: item.url, urls, rejected };
    }
    yield { type: "doc", doc };
  }
}

// ---------- page outlinks ----------

/** Per-page cap. Generous: a page over it is flagged `capped` rather than silently trimmed. */
export const MAX_OUTLINKS_PER_PAGE = 10_000;

export interface Outlink {
  url: string;
  /** Attribute value as written in the page. */
  original: string;
  via: Exclude<DiscoverySource, "seed" | "sitemap" | "redirect">;
  anchor: string | null;
  rel: string;
  location: LinkLocation;
  nofollow: boolean;
  hreflang?: string;
}

export interface PageOutlinks {
  links: Outlink[];
  rejected: (RejectedUrl & { via: Outlink["via"] })[];
  capped: boolean;
}

function locationOf($: Doc, el: Parameters<Doc>[0]): LinkLocation {
  const node = $(el);
  if (node.closest("footer, [role=contentinfo]").length) return "footer";
  if (node.closest("nav, header, [role=navigation], [role=banner]").length) return "nav";
  return "main";
}

const relTokens = (rel: string | undefined) => (rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Every crawlable reference on a page, tagged with its discovery source: <a>/<area> href, <link rel=canonical>,
 * rel=next/prev, rel=alternate (with or without hreflang) and <iframe src>. Respects <base href>.
 * Fragment-only and empty references point at the page itself and are skipped.
 */
export function extractOutlinks($: Doc, pageUrl: string, opts: NormaliseOptions = {}): PageOutlinks {
  const baseHref = $("base[href]").first().attr("href");
  const baseCheck = baseHref ? normaliseUrl(baseHref, { base: pageUrl, dropParams: [] }) : null;
  const base = baseCheck?.ok ? new URL(baseHref!, pageUrl).toString() : pageUrl;
  const links: Outlink[] = [];
  const rejected: PageOutlinks["rejected"] = [];
  const dedupe = new Set<string>();
  let capped = false;

  const add = (raw: string | undefined, via: Outlink["via"], el: Parameters<Doc>[0], extra: { anchor?: string | null; rel?: string; hreflang?: string } = {}) => {
    const value = raw?.trim();
    if (!value || value.startsWith("#")) return;
    const n = normaliseUrl(value, { ...opts, base });
    if (!n.ok) {
      rejected.push({ original: value, reason: n.reason, via });
      return;
    }
    const rel = extra.rel ?? "";
    const location = locationOf($, el);
    const key = `${via}\u0000${n.url}\u0000${extra.anchor ?? ""}\u0000${location}\u0000${rel}\u0000${extra.hreflang ?? ""}`; // en and x-default often share a URL
    if (dedupe.has(key)) return;
    if (links.length >= MAX_OUTLINKS_PER_PAGE) {
      capped = true;
      return;
    }
    dedupe.add(key);
    links.push({
      url: n.url,
      original: value,
      via,
      anchor: extra.anchor ?? null,
      rel,
      location,
      nofollow: relTokens(rel).includes("nofollow"),
      ...(extra.hreflang ? { hreflang: extra.hreflang } : {}),
    });
  };

  $("a[href], area[href]").each((_, el) => {
    const node = $(el);
    const anchor = node.text().replace(/\s+/g, " ").trim() || node.find("img[alt]").first().attr("alt")?.trim() || node.attr("aria-label")?.trim() || "";
    add(node.attr("href"), "link", el, { anchor: anchor.slice(0, 500), rel: node.attr("rel") ?? "" });
  });
  $("link[href][rel]").each((_, el) => {
    const node = $(el);
    const rel = node.attr("rel") ?? "";
    const tokens = relTokens(rel);
    const href = node.attr("href");
    if (tokens.includes("canonical")) add(href, "canonical", el, { rel });
    if (tokens.includes("next") || tokens.includes("prev") || tokens.includes("previous")) add(href, "pagination", el, { rel });
    if (tokens.includes("alternate")) {
      const hreflang = node.attr("hreflang")?.trim();
      add(href, hreflang ? "hreflang" : "alternate", el, { rel, hreflang });
    }
  });
  $("iframe[src]").each((_, el) => add($(el).attr("src"), "iframe", el));

  return { links, rejected, capped };
}
