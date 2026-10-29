// PageSnapshot (docs/SPEC.md "Phase 2" item 1): everything rules read about one fetched URL. Rules never fetch;
// they read this. Stored in page_snapshots, one row per fetched URL; the raw HTML is gzipped to the blob store
// and only its key is kept here.
import type { LinkLocation } from "../crawl/v2/types";

export interface HeadTag {
  tag: string;
  attrs: Record<string, string>;
  /** Text content, for <title> only. */
  text?: string;
}

export interface CanonicalTag {
  /** href as written. */
  href: string;
  /** Absolute URL it resolves to, or null when it cannot be parsed. */
  resolved: string | null;
  /** Where it was found. A body canonical is ignored by search engines. */
  location: "head" | "body" | "header";
  /** href is an absolute http(s) URL. */
  absolute: boolean;
}

export interface RobotsDirective {
  source: "meta" | "header";
  /** Meta name (robots, googlebot…) or the header's user-agent prefix; "*" when the header has none. */
  agent: string;
  /** Lower-cased directive tokens, e.g. ["noindex", "follow"]. */
  directives: string[];
}

export interface RobotsSnapshot {
  directives: RobotsDirective[];
  /** Effective for all crawlers (meta robots and unprefixed X-Robots-Tag). */
  noindex: { meta: boolean; header: boolean };
  nofollow: { meta: boolean; header: boolean };
}

export interface HeadingEntry {
  level: 1 | 2 | 3 | 4 | 5 | 6;
  text: string;
}

export interface SnapshotLink {
  href: string;
  /** Attribute value as written. */
  original: string;
  via: string;
  anchor: string | null;
  rel: string;
  location: LinkLocation;
  nofollow: boolean;
  /** hreflang value as written, on <link rel="alternate" hreflang> (via "hreflang"). */
  hreflang?: string;
}

export interface SnapshotImage {
  src: string;
  /** Resolved absolute URL, or null when unparseable. */
  resolved: string | null;
  /** null when the alt attribute is absent; "" when present and empty. */
  alt: string | null;
  width: string | null;
  height: string | null;
  loading: string | null;
  srcset: string | null;
  /** Inside an <a href>. Absent on snapshots from before Phase 2b. */
  linked?: boolean;
  /** Inside the main-content element (see mainContentText) and outside boilerplate. Absent before Phase 2b. */
  inMain?: boolean;
  /** The direct child of a <picture> with <source srcset> (responsive by art direction). Absent before Phase 2b. */
  inPicture?: boolean;
}

export interface JsonLdBlock {
  raw: string;
  parsed: unknown;
  error: string | null;
}

export interface LanguageSnapshot {
  /** <html lang> as written, or null. */
  declared: string | null;
  /** Detected from main-content text (tinyld); null when the text is too short to judge. */
  detected: string | null;
  /** Detector confidence, 0–1. */
  accuracy: number | null;
}

/** Head facts the metadata rules read, beyond the tag list. */
export interface PageFacts {
  /** Charset from <meta charset> or http-equiv Content-Type, with the byte offset where it starts. */
  metaCharset: { value: string; offset: number } | null;
  /** charset parameter of the Content-Type header. */
  headerCharset: string | null;
  viewport: string[];
  og: { title: string | null; image: string | null; url: string | null };
  twitterCard: string | null;
  /** Declared icons (<link rel~=icon>), resolved. */
  icons: string[];
  metaRefresh: { content: string; target: string | null } | null;
  /** Target of a script-driven redirect (location.href = …, location.replace(…)), when one is literal in the page. */
  jsRedirect: string | null;
  /** Stylesheets and scripts the page loads, resolved (rules check them against robots.txt). */
  renderResources: string[];
  /** <video> elements: resolved src (or first <source src>) and poster. Absent on snapshots from before Phase 2b. */
  videos?: { src: string | null; poster: string | null }[];
  /** Characters of visible text in <body> (boilerplate included). */
  bodyTextChars: number;
  /** Characters of main-content text. */
  mainTextChars: number;
  /** Bytes of HTML read. */
  htmlBytes: number;
}

export interface PageSnapshot {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  /** Redirect hops that led the crawler here, oldest first (filled by analysis from the redirect edges). */
  redirectChain: { url: string; status: number | null }[];
  headers: Record<string, string>;
  /** Blob-store key of the gzipped raw HTML; null when there was no HTML body to store. */
  rawHtmlKey: string | null;
  bytes: number;
  truncated: boolean;
  head: HeadTag[];
  canonicals: CanonicalTag[];
  robots: RobotsSnapshot;
  /** Text of every document <title> (SVG/MathML titles excluded), in order. */
  titles: string[];
  /** Content of every meta description, in order. */
  descriptions: string[];
  outline: HeadingEntry[];
  mainText: string;
  wordCount: number;
  language: LanguageSnapshot;
  links: SnapshotLink[];
  images: SnapshotImage[];
  jsonLd: JsonLdBlock[];
  /** sha256 of the body as read. */
  contentHash: string | null;
  /** sha256 of the normalised main-content text; null under 50 words. */
  textHash: string | null;
  simhash: string | null;
  templateFingerprint: string | null;
  timings: { fetchMs: number; extractMs: number };
  facts: PageFacts;
}

/** What extraction produces from one HTML body (the rest of the snapshot comes from the response). */
export type ExtractedHtml = Omit<PageSnapshot, "requestedUrl" | "finalUrl" | "statusCode" | "contentType" | "redirectChain" | "headers" | "rawHtmlKey" | "bytes" | "truncated" | "contentHash" | "timings">;
