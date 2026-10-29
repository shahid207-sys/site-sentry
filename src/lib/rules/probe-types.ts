// Crawl-level probes: a fixed, small set of requests the crawl worker makes once per crawl so site rules can judge
// things no crawled page shows (docs/PHASE-2.md "Probes"). Stored in crawls.probes; not charged to the URL budget.
import type { PeerCertificateInfo } from "../fetch/safe-fetch";

export type ProbeKind =
  | "home_scheme" // the start page on the other scheme (IDX-020)
  | "home_www" // the start page on the www / non-www host (IDX-021)
  | "favicon" // the declared icon, else /favicon.ico (META-019)
  | "llms_txt" // /llms.txt (AIS-003)
  | "og_image" // an og:image URL (META-017)
  | "robots_txt" // robots.txt of another host a probe targets, read before probing it
  | "tls_cert" // the start host's certificate, by TLS handshake only (SEC-003)
  | "env_file" // /.env (SEC-006): only whether the body looks like one is kept, never the body
  | "git_head"; // /.git/HEAD (SEC-006): likewise

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
  /** For tls_cert: the certificate the host presented. */
  cert?: PeerCertificateInfo;
  /**
   * For env_file and git_head: the signature the body matched, or null when it matched none (soft 404, HTML page,
   * anything else). The body itself is never stored.
   */
  secret?: SecretMatch | null;
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

/** What an exposed-file probe body matched: the signature's name and how many lines matched. Never any content. */
export interface SecretMatch {
  pattern: "env_key_value" | "git_head_ref";
  lines: number;
}

/** A .env body: at least 80% of its non-blank, non-comment lines are KEY=value (optionally "export KEY=value"). */
const ENV_LINE = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=/;
const looksLikeHtml = (body: string, contentType: string | undefined) => /html/i.test(contentType ?? "") || body.trimStart().startsWith("<");

/**
 * Does a 200 response body look like an exposed file? Pure: the probe calls it on the response and stores only the
 * result. An HTML page (by content type, or a body starting with "<") never matches: that is a soft 404 or a catch-all
 * route, not the file.
 */
export function exposedFileMatch(kind: "env_file" | "git_head", body: string, contentType?: string): SecretMatch | null {
  if (looksLikeHtml(body, contentType)) return null;
  if (kind === "git_head") return /^ref: refs\//.test(body.trimStart()) ? { pattern: "git_head_ref", lines: 1 } : null;
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  const kv = lines.filter((l) => ENV_LINE.test(l)).length;
  return lines.length && kv / lines.length >= 0.8 ? { pattern: "env_key_value", lines: kv } : null;
}
