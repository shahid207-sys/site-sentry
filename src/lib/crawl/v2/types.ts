// Shared vocabulary for crawler v2 (docs/SPEC.md "Crawler engine").

/** How a URL entered the inventory. A URL keeps every source that found it. */
export const DISCOVERY_SOURCES = [
  "seed", // start URL or user seed list
  "sitemap", // any XML sitemap (robots.txt declaration, /sitemap.xml, /sitemap_index.xml, or a child of an index)
  "link", // <a href> / <area href>
  "canonical", // <link rel=canonical>
  "pagination", // <link rel=next|prev>
  "hreflang", // <link rel=alternate hreflang>
  "alternate", // other <link rel=alternate> (feeds, AMP, media)
  "iframe", // <iframe src>
  "redirect", // Location target of a fetched URL
] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];

/**
 * Non-terminal states, in order. `fetching` is not in the spec's list: it marks a URL whose claim is committed and
 * whose request may already have been sent (needed for at-most-once accounting). See docs/CRAWLER-STATES.md.
 */
export const ACTIVE_STATES = ["discovered", "queued", "fetching"] as const;

/**
 * Terminal states. Every URL ends in exactly one, with a reason. `fetched` is terminal for Phase 1
 * (no analysis worker yet); Phase 2 moves fetched URLs on to `analysed`.
 */
export const TERMINAL_STATES = [
  "fetched",
  "analysed",
  "blocked_robots",
  "out_of_scope",
  "excluded_by_rule",
  "budget_exhausted",
  "depth_exceeded",
  "redirected",
  "failed_timeout",
  "failed_dns",
  "failed_tls",
  // Not in the spec's list (see docs/CRAWLER-STATES.md):
  "failed_network", // connection refused/reset, protocol error, or refused by the SSRF guard; the reason says which
  "interrupted", // claimed, then the worker stopped before recording a result; never re-requested (at-most-once)
  "non_html",
  "oversized",
  "cancelled",
] as const;

export type ActiveState = (typeof ACTIVE_STATES)[number];
export type TerminalState = (typeof TERMINAL_STATES)[number];
export type UrlState = ActiveState | TerminalState;

export const isTerminal = (s: UrlState): s is TerminalState => (TERMINAL_STATES as readonly string[]).includes(s);

/** Where on the page a link sits (spec url_edges.location). */
export type LinkLocation = "nav" | "main" | "footer";
