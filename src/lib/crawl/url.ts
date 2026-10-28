// URL identity used for page keys, issue fingerprints and internal-link decisions. Pure.

/**
 * Canonical identity of a page URL: lower-cased scheme and host, default port removed,
 * fragment removed, empty path → "/". Path case, trailing slashes and query strings are kept,
 * because servers (and search engines) treat those as different URLs.
 */
export function normalizePageUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.hash = "";
  u.username = "";
  u.password = "";
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) u.port = "";
  return u.toString();
}

/** Resolve an href found in a page. Returns null for non-http(s) targets (mailto:, javascript:, tel:, data:…). */
export function resolveHref(href: string | undefined | null, base: string): string | null {
  if (!href) return null;
  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  return normalizePageUrl(trimmed, base);
}

/** The site's origin as a normalised "scheme://host" string. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return `${u.protocol}//${u.host.toLowerCase()}`;
  } catch {
    return null;
  }
}

/** Internal = same hostname as the site (scheme ignored, so http→https links still count as internal). */
export function isInternal(url: string, siteOrigin: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === new URL(siteOrigin).hostname.toLowerCase();
  } catch {
    return false;
  }
}

/** Only http(s) URLs are ever rendered as links in the UI. Everything else is shown as text. */
export function isSafeHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Short display form: path + query for internal URLs. */
export function displayPath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}` || "/";
  } catch {
    return url;
  }
}
