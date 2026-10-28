// Crawl-level probes: a fixed, small set of requests the crawl worker makes once per crawl so site rules can judge
// things no crawled page shows (docs/PHASE-2.md "Probes"). Stored in crawls.probes; not charged to the URL budget.

export type ProbeKind =
  | "home_scheme" // the start page on the other scheme (IDX-020)
  | "home_www" // the start page on the www / non-www host (IDX-021)
  | "favicon" // the declared icon, else /favicon.ico (META-019)
  | "llms_txt" // /llms.txt (AIS-003)
  | "og_image" // an og:image URL (META-017)
  | "robots_txt"; // robots.txt of another host a probe targets, read before probing it

export interface ProbeRecord {
  kind: ProbeKind;
  url: string;
  /** False while queued for a throttle slot; set just before the request. A resumed crawl never re-sends a started probe. */
  started: boolean;
  status: number | null;
  contentType?: string;
  /** Redirect target, when the response was a redirect (probes do not follow redirects). */
  location?: string;
  /** For llms_txt: the body as read (capped). */
  body?: string;
  /** For og_image: intrinsic size read from the image header. */
  width?: number;
  height?: number;
  error?: { code: string; message: string };
  /** For robots_txt: the file as read (capped), to decide later probes to that host. */
  robotsBody?: string;
  /** Set when the probe was not sent, and why. */
  skipped?: string;
  /** Machine-readable form of `skipped`. */
  skipCode?: "probe_skipped_robots" | "over_cap" | "interrupted";
}

/** The probe was not sent because robots.txt of its host disallows it (or could not be read): rules relying on it are inconclusive. */
export const skippedByRobots = (p: ProbeRecord | undefined): p is ProbeRecord & { skipCode: "probe_skipped_robots" } => p?.skipCode === "probe_skipped_robots";

/** og:image URLs probed per crawl, at most. */
export const MAX_OG_IMAGE_PROBES = 10;

/** The absolute URL an og:image value names, as probed and as META-017 looks it up; null when unusable. */
export function resolveOgImage(raw: string | null, pageUrl: string): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw.trim(), pageUrl);
    return /^https?:$/.test(u.protocol) ? u.toString() : null;
  } catch {
    return null;
  }
}
