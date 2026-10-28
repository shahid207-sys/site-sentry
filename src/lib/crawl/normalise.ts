// URL normalisation for crawler v2, per docs/SPEC.md "Crawler engine → URL normalisation".
// Where the spec is silent the WHATWG URL Standard applies; every such choice is listed in
// docs/CRAWLER-NORMALISATION.md. Pure. The legacy engine keeps ./url.ts (its output is part of
// stored issue fingerprints) until Phase 3 rebuilds fingerprints.

/** Tracking parameters dropped by default (spec). Matched case-insensitively on the decoded name. */
export const DEFAULT_TRACKING_PARAMS: readonly (string | RegExp)[] = [/^utm_/, "gclid", "fbclid"];

export const MAX_URL_LENGTH = 2048;

export interface NormaliseOptions {
  /** Base URL for relative references (the page the link was found on, or its <base href>). */
  base?: string;
  /** Parameters to drop. Defaults to DEFAULT_TRACKING_PARAMS; pass a longer list to add project-specific ones. */
  dropParams?: readonly (string | RegExp)[];
}

export type NormaliseFailure = "invalid" | "unsupported_scheme" | "credentials" | "too_long";

export type Normalised =
  | { ok: true; url: string; original: string }
  | { ok: false; original: string; reason: NormaliseFailure };

function decodeName(raw: string): string {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " ")).toLowerCase();
  } catch {
    return raw.toLowerCase();
  }
}

function isDropped(rawName: string, drop: readonly (string | RegExp)[]): boolean {
  const name = decodeName(rawName);
  return drop.some((d) => (typeof d === "string" ? d.toLowerCase() === name : d.test(name)));
}

/**
 * Sort query parameters by name (stable, so repeated names keep their relative order) and drop tracking
 * parameters. Works on the raw serialised pairs so percent-encoding and "+" are kept byte for byte.
 */
function normaliseQuery(search: string, drop: readonly (string | RegExp)[]): string {
  const pairs = search
    .replace(/^\?/, "")
    .split("&")
    .filter((p) => p !== "")
    .map((p) => {
      const eq = p.indexOf("=");
      return { name: eq === -1 ? p : p.slice(0, eq), raw: p };
    })
    .filter((p) => !isDropped(p.name, drop));
  pairs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return pairs.length ? `?${pairs.map((p) => p.raw).join("&")}` : "";
}

/** Normalise a URL as found (absolute, or relative to `opts.base`). The input is returned as `original` for evidence. */
export function normaliseUrl(input: string, opts: NormaliseOptions = {}): Normalised {
  const original = input;
  let u: URL;
  try {
    u = new URL(input, opts.base);
  } catch {
    return { ok: false, original, reason: "invalid" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { ok: false, original, reason: "unsupported_scheme" };
  // Never persist credentials; authenticated crawls use project-scoped, encrypted auth settings instead.
  if (u.username || u.password) return { ok: false, original, reason: "credentials" };
  u.hash = "";
  // WHATWG has already lower-cased scheme and host, removed default ports, resolved dot segments,
  // converted backslashes, IDNA-encoded the host and canonicalised IPv4/IPv6 literals.
  const search = normaliseQuery(u.search, opts.dropParams ?? DEFAULT_TRACKING_PARAMS);
  const url = `${u.protocol}//${u.host}${u.pathname}${search}`;
  if (url.length > MAX_URL_LENGTH) return { ok: false, original, reason: "too_long" };
  return { ok: true, url, original };
}

/** Normalised URL or null; for callers that only need the string. */
export function normaliseOrNull(input: string, opts?: NormaliseOptions): string | null {
  const r = normaliseUrl(input, opts);
  return r.ok ? r.url : null;
}

/**
 * Key shared by trailing-slash and path-case variants of a normalised URL. The spec keeps those URLs
 * distinct but flags them as duplicates; URLs with the same key and different `url` are such variants.
 */
export function variantKey(normalisedUrl: string): string {
  const u = new URL(normalisedUrl);
  const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
  return `${u.protocol}//${u.host}${path.toLowerCase()}${u.search}`;
}
