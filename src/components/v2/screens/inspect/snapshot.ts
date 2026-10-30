// Reading the raw page_snapshots row (snake_case jsonb, as PageDetail.snapshot returns it) defensively: older
// snapshots lack later fields, and a response without an HTML body has empty lists and null robots / language.
// Also the plain-words explanation of a URL the crawler did not read as a page.
import type { CanonicalTag, HeadTag, HeadingEntry, JsonLdBlock, LanguageSnapshot, RobotsSnapshot, SnapshotImage } from "@/lib/snapshot/types";

/**
 * Copied from SNAPSHOT_CAPS in src/lib/snapshot/extract.ts (not imported: it pulls the HTML parser into the client).
 * The crawler keeps at most this many of each, and cuts a JSON-LD block at this many characters before parsing it.
 */
export const SNAPSHOT_CAPS = { headTags: 300, headings: 500, images: 1000, jsonLdChars: 100_000 } as const;

export interface SnapshotView {
  requestedUrl: string | null;
  finalUrl: string | null;
  statusCode: number | null;
  contentType: string | null;
  redirectChain: { url: string; status: number | null }[];
  /** Response headers sorted by name. */
  headers: [string, string][];
  bytes: number | null;
  truncated: boolean;
  elapsedMs: number | null;
  /** False when the response had no HTML body to extract (non-HTML, or an error status): page fields are empty. */
  extracted: boolean;
  head: HeadTag[];
  canonicals: CanonicalTag[];
  robots: RobotsSnapshot | null;
  titles: string[];
  descriptions: string[];
  outline: HeadingEntry[];
  wordCount: number | null;
  language: LanguageSnapshot | null;
  images: SnapshotImage[];
  jsonLd: JsonLdBlock[];
  contentHash: string | null;
  textHash: string | null;
  templateFingerprint: string | null;
  timings: { fetchMs: number | null; extractMs: number | null } | null;
  /** "stored", "blob_missing", or null when there was no HTML to store. */
  blobStatus: string | null;
  fetchedAt: string | null;
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const obj = (v: unknown): Record<string, unknown> | null => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

function headTag(v: unknown): HeadTag | null {
  const o = obj(v);
  if (!o || typeof o.tag !== "string") return null;
  const attrs: Record<string, string> = {};
  for (const [k, x] of Object.entries(obj(o.attrs) ?? {})) if (typeof x === "string") attrs[k] = x;
  return { tag: o.tag, attrs, ...(typeof o.text === "string" ? { text: o.text } : {}) };
}

function canonical(v: unknown): CanonicalTag | null {
  const o = obj(v);
  if (!o || typeof o.href !== "string") return null;
  const location = o.location === "head" || o.location === "body" || o.location === "header" ? o.location : "head";
  return { href: o.href, resolved: str(o.resolved), location, absolute: o.absolute === true };
}

function robots(v: unknown): RobotsSnapshot | null {
  const o = obj(v);
  if (!o) return null;
  const flags = (x: unknown) => ({ meta: obj(x)?.meta === true, header: obj(x)?.header === true });
  return {
    directives: list(o.directives).flatMap((d) => {
      const x = obj(d);
      if (!x) return [];
      return [{ source: x.source === "header" ? ("header" as const) : ("meta" as const), agent: str(x.agent) ?? "*", directives: list(x.directives).filter((t): t is string => typeof t === "string") }];
    }),
    noindex: flags(o.noindex),
    nofollow: flags(o.nofollow),
  };
}

function heading(v: unknown): HeadingEntry | null {
  const o = obj(v);
  const level = num(o?.level);
  if (!o || level === null || level < 1 || level > 6) return null;
  return { level: Math.round(level) as HeadingEntry["level"], text: str(o.text) ?? "" };
}

function image(v: unknown): SnapshotImage | null {
  const o = obj(v);
  if (!o || typeof o.src !== "string") return null;
  return {
    src: o.src,
    resolved: str(o.resolved),
    // null = attribute absent, "" = present and empty: keep the difference.
    alt: typeof o.alt === "string" ? o.alt : null,
    width: str(o.width) ?? (num(o.width) === null ? null : String(o.width)),
    height: str(o.height) ?? (num(o.height) === null ? null : String(o.height)),
    loading: str(o.loading),
    srcset: str(o.srcset),
    ...(typeof o.linked === "boolean" ? { linked: o.linked } : {}),
    ...(typeof o.inMain === "boolean" ? { inMain: o.inMain } : {}),
  };
}

function jsonLd(v: unknown): JsonLdBlock | null {
  const o = obj(v);
  if (!o) return null;
  return { raw: str(o.raw) ?? "", parsed: o.parsed ?? null, error: str(o.error) };
}

function language(v: unknown): LanguageSnapshot | null {
  const o = obj(v);
  return o ? { declared: str(o.declared), detected: str(o.detected), accuracy: num(o.accuracy) } : null;
}

const each = <T>(v: unknown, f: (x: unknown) => T | null): T[] => list(v).flatMap((x) => {
  const y = f(x);
  return y === null ? [] : [y];
});

/** The snapshot row as typed, tolerant fields; null when the URL has no snapshot. */
export function readSnapshot(raw: Record<string, unknown> | null): SnapshotView | null {
  if (!raw) return null;
  const t = obj(raw.timings);
  const fetched = raw.fetched_at;
  return {
    requestedUrl: str(raw.requested_url),
    finalUrl: str(raw.final_url),
    statusCode: num(raw.status_code),
    contentType: str(raw.content_type),
    redirectChain: list(raw.redirect_chain).flatMap((h) => {
      const o = obj(h);
      return o && typeof o.url === "string" ? [{ url: o.url, status: num(o.status) }] : [];
    }),
    headers: Object.entries(obj(raw.headers) ?? {})
      .map(([k, v]): [string, string] => [k, typeof v === "string" ? v : JSON.stringify(v)])
      .sort((a, b) => a[0].localeCompare(b[0])),
    bytes: num(raw.bytes),
    truncated: raw.truncated === true,
    elapsedMs: num(raw.elapsed_ms),
    // The crawler writes robots (and language) only when it extracted an HTML body.
    extracted: obj(raw.robots) !== null,
    head: each(raw.head, headTag),
    canonicals: each(raw.canonicals, canonical),
    robots: robots(raw.robots),
    titles: list(raw.titles).filter((x): x is string => typeof x === "string"),
    descriptions: list(raw.descriptions).filter((x): x is string => typeof x === "string"),
    outline: each(raw.outline, heading),
    wordCount: num(raw.word_count),
    language: language(raw.language),
    images: each(raw.images, image),
    jsonLd: each(raw.json_ld, jsonLd),
    contentHash: str(raw.content_hash),
    textHash: str(raw.text_hash),
    templateFingerprint: str(raw.template_fingerprint),
    timings: t ? { fetchMs: num(t.fetchMs), extractMs: num(t.extractMs) } : null,
    blobStatus: str(raw.blob_status),
    fetchedAt: typeof fetched === "string" ? fetched : fetched instanceof Date ? fetched.toISOString() : null,
  };
}

/** A tag as HTML-like text, e.g. `<meta name="robots" content="noindex">` (rendered as text, never as HTML). */
export function headTagText(t: HeadTag): string {
  const attrs = Object.entries(t.attrs).map(([k, v]) => ` ${k}="${v.replace(/"/g, "&quot;")}"`).join("");
  return t.text !== undefined ? `<${t.tag}${attrs}>${t.text}</${t.tag}>` : `<${t.tag}${attrs}>`;
}

/** An image's alt in words: absent and empty are different findings (empty marks a decorative image). */
export function altText(alt: string | null): { kind: "absent" | "empty" | "text"; label: string } {
  if (alt === null) return { kind: "absent", label: "No alt attribute" };
  if (alt.trim() === "") return { kind: "empty", label: 'Empty alt="" (decorative)' };
  return { kind: "text", label: alt };
}

/** Byte counts as B / KB / MB (1024-based, one decimal). */
export function fmtBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const STATE_WORDS: Record<string, string> = {
  discovered: "The crawler found this URL but had not requested it when the crawl ended.",
  queued: "The crawler reserved this URL but had not sent the request.",
  fetching: "The request was in flight; no result was saved.",
  fetched: "The crawler read this URL.",
  analysed: "The crawler read and analysed this URL.",
  redirected: "This URL redirects. The crawler recorded the redirect and queued its target instead of reading a page here.",
  non_html: "The response was not an HTML page, so there is no page content to inspect.",
  oversized: "The page was larger than the crawler's size limit, so it was not read as a page.",
  blocked_robots: "robots.txt disallows this URL for the crawler, so it was never requested.",
  excluded_by_rule: "The crawler rejected this reference (for example it could not be normalised), so it was never requested.",
  out_of_scope: "This URL is outside the audit's scope (another host, subfolder or include/exclude rule), so it was never requested.",
  cdn_managed: "This is a CDN-managed path on the site, which the crawler never requests.",
  budget_exhausted: "The crawl's URL budget ran out before this URL was requested.",
  depth_exceeded: "This URL is deeper than the audit's depth limit, so it was not requested.",
  cancelled: "The crawl stopped before this URL was requested.",
  interrupted: "A worker stopped while this request may have been in flight; the crawler never requests a URL twice, so it has no result.",
  failed_timeout: "The request timed out.",
  failed_network: "The connection failed.",
  failed_dns: "The host name could not be resolved.",
  failed_tls: "The secure (TLS) connection failed.",
};

/** Why a URL has no page snapshot, in plain words (docs/CRAWLER-STATES.md). */
export const stateWords = (state: string) => STATE_WORDS[state] ?? `The crawler left this URL in the state "${state.replace(/_/g, " ")}".`;
