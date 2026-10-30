import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { connect as tlsConnect, createSecureContext, rootCertificates, type PeerCertificate, type SecureContext } from "node:tls";
import { gunzipSync } from "node:zlib";
import type { ReadableStream } from "node:stream/web";
import { Agent, fetch } from "undici";
import { isBlockedIp } from "./ip-guard";
import type { RedirectHop } from "../audit/types";

export const MAX_REDIRECTS = 5;
export const MAX_BYTES = 2 * 1024 * 1024; // 2 MB of HTML is plenty for head-level checks
export const MAX_XML_BYTES = 5 * 1024 * 1024; // sitemaps can be larger
/** sitemaps.org limit per sitemap file, compressed or not. */
export const MAX_SITEMAP_BYTES = 50 * 1024 * 1024;
export const MAX_TEXT_BYTES = 512 * 1024; // robots.txt (Google reads the first 500 KiB)
export const MAX_IMAGE_HEAD_BYTES = 64 * 1024; // enough for the size fields of PNG, GIF, WebP and almost every JPEG
/** One subresource a rendered page loads (script, stylesheet, image, font, XHR). */
export const MAX_RESOURCE_BYTES = 10 * 1024 * 1024;
export const TIMEOUT_MS = 10_000;
/** Spec "Crawler engine": 10 s to open a connection, for every caller. */
export const CONNECT_TIMEOUT_MS = 10_000;
/**
 * Backstop for waiting on headers or body. The real limit is each request's total timeout (`timeoutMs`, enforced with
 * an AbortSignal: 10 s legacy, 30 s crawler v2), so this only has to be longer than any of them.
 */
const SOCKET_IDLE_BACKSTOP_MS = 60_000;
// Spec "Crawler engine → Security": http(s) on 80, 443, 8080 and 8443 unless an admin overrides the policy.
const ALLOWED_PORTS = new Set(["", "80", "443", "8080", "8443"]);
export const USER_AGENT = "SiteSentryBot/0.2 (+technical SEO audit; respects robots.txt)";

export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "BLOCKED_HOST"
  | "DNS_FAILED"
  | "TIMEOUT"
  | "TOO_MANY_REDIRECTS"
  | "HTTP_ERROR"
  | "NOT_HTML"
  | "TLS"
  | "NETWORK";

export class SafeFetchError extends Error {
  constructor(
    public code: SafeFetchErrorCode,
    message: string,
    public httpStatus?: number,
  ) {
    super(message);
    this.name = "SafeFetchError";
  }
}

/** Resolve a hostname to every address it has. Injected so tests can point it at a local DNS stub. */
export type ResolveHost = (hostname: string) => Promise<string[]>;

/** Which targets a fetcher may reach. `DEFAULT_POLICY` is the production policy; tests and the local fixture site widen it. */
export interface FetchPolicy {
  resolve: ResolveHost;
  isBlocked: (ip: string) => boolean;
  allowedPorts: ReadonlySet<string>;
  /** Allow single-label and .local/.internal/.localhost names (they still have to resolve to allowed addresses). */
  allowLocalNames: boolean;
  /** Extra trusted CA certificates (PEM), added to the system roots. Test policies only: the local fixture's TLS listener. */
  ca?: string[];
}

export const systemResolve: ResolveHost = async (hostname) => (await dnsLookupAsync(hostname, { all: true, verbatim: true })).map((a) => a.address);

export const DEFAULT_POLICY: FetchPolicy = { resolve: systemResolve, isBlocked: isBlockedIp, allowedPorts: ALLOWED_PORTS, allowLocalNames: false };

/** Parse and validate user input. Adds https:// when no scheme is given. Pure — no DNS. */
export function validateTargetUrl(input: string, policy: FetchPolicy = DEFAULT_POLICY): URL {
  const trimmed = input.trim();
  if (!trimmed) throw new SafeFetchError("INVALID_URL", "Enter a URL to audit.");
  if (trimmed.length > 2048) throw new SafeFetchError("INVALID_URL", "URLs longer than 2048 characters are not supported.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new SafeFetchError("INVALID_URL", `"${input.slice(0, 200)}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("INVALID_URL", "Only http:// and https:// URLs can be audited.");
  }
  if (url.username || url.password) {
    throw new SafeFetchError("INVALID_URL", "URLs containing credentials are not allowed.");
  }
  if (!policy.allowedPorts.has(url.port)) {
    throw new SafeFetchError("BLOCKED_HOST", "Only ports 80, 443, 8080 and 8443 are allowed.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const bareHost = host.replace(/^\[|\]$/g, "");
  if (!policy.allowLocalNames) {
    if (!host.includes(".") && !isIP(bareHost)) {
      throw new SafeFetchError("BLOCKED_HOST", "Enter a public domain name (e.g. example.com).");
    }
    if (/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host)) {
      throw new SafeFetchError("BLOCKED_HOST", "Local and internal hostnames cannot be audited.");
    }
  }
  if (isIP(bareHost) && policy.isBlocked(bareHost)) throw blockedError(bareHost);
  url.hash = "";
  return url;
}

/**
 * Resolve the host once and return the validated addresses, in answer order, that the socket may connect to.
 * Rejects if ANY resolved address is blocked: a name with one private record is treated as hostile,
 * because we cannot know which record a later connection would get.
 */
export async function resolvePinned(url: URL, policy: FetchPolicy = DEFAULT_POLICY): Promise<string[]> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (policy.isBlocked(host)) throw blockedError(host);
    return [host];
  }
  let addrs: string[];
  try {
    addrs = await policy.resolve(host);
  } catch {
    throw new SafeFetchError("DNS_FAILED", `Could not resolve ${host}.`);
  }
  if (addrs.length === 0) throw new SafeFetchError("DNS_FAILED", `Could not resolve ${host}.`);
  const bad = addrs.find((a) => policy.isBlocked(a));
  if (bad) throw blockedError(host, bad);
  return [...new Set(addrs)];
}

const CONNECT_ERROR_CODES = new Set(["ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL", "UND_ERR_CONNECT_TIMEOUT"]);

/** True when the request failed while opening the socket, i.e. before any request bytes were sent. */
function isConnectError(e: unknown): boolean {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: string }).code;
    if (code && CONNECT_ERROR_CODES.has(code)) return true;
    cur = (cur as { cause?: unknown }).cause;
  }
  return false;
}

function blockedError(host: string, ip?: string) {
  const detail = ip && ip !== host ? ` (${host} resolves to ${ip})` : "";
  return new SafeFetchError("BLOCKED_HOST", `Refusing to fetch a private or reserved address${detail}.`);
}

/**
 * A dispatcher whose sockets always connect to `ip`, never to a fresh DNS answer, so a DNS response
 * that changes after validation (rebinding) cannot redirect the connection. The URL keeps its hostname,
 * so the Host header, SNI and certificate verification still use the name.
 */
function pinnedLookup(ip: string) {
  const family = isIP(ip);
  return (_hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void) => {
    if (options?.all) callback(null, [{ address: ip, family }]);
    else callback(null, ip, family);
  };
}

/**
 * One TLS context per set of extra CAs. A `ca` option on a connection makes Node build a new native context (the whole
 * root store parsed again) for every socket; each closed body (a ranged image read, a HEAD) opens a new socket, so
 * thousands of contexts piled up outside the V8 heap. Without extra CAs Node's own cached default context is used.
 */
const secureContexts = new Map<string, SecureContext>();
function caContext(ca: string[] | undefined): { secureContext: SecureContext } | Record<string, never> {
  if (!ca?.length) return {};
  const key = createHash("sha256").update(ca.join("\n")).digest("hex");
  let c = secureContexts.get(key);
  if (!c) secureContexts.set(key, (c = createSecureContext({ ca: [...rootCertificates, ...ca] })));
  return { secureContext: c };
}

const MAX_PINNED_AGENTS = 256;
const pinnedAgents = new Map<string, Agent>();

/** One keep-alive agent per (host, pinned address, extra CAs), so repeat requests to a host reuse connections. */
export function pinnedAgent(hostname: string, ip: string, ca?: string[]): Agent {
  const caKey = ca?.length ? createHash("sha256").update(ca.join("\n")).digest("hex").slice(0, 16) : "";
  const key = `${hostname}\u0000${ip}\u0000${caKey}`;
  let a = pinnedAgents.get(key);
  if (a) {
    pinnedAgents.delete(key); // move to the back: the map doubles as an LRU
    pinnedAgents.set(key, a);
    return a;
  }
  a = new Agent({
    connect: { lookup: pinnedLookup(ip), timeout: CONNECT_TIMEOUT_MS, ...caContext(ca) },
    headersTimeout: SOCKET_IDLE_BACKSTOP_MS,
    bodyTimeout: SOCKET_IDLE_BACKSTOP_MS,
    connections: 8,
  });
  pinnedAgents.set(key, a);
  if (pinnedAgents.size > MAX_PINNED_AGENTS) {
    const [oldKey, old] = pinnedAgents.entries().next().value!;
    pinnedAgents.delete(oldKey);
    void old.close().catch(() => undefined);
  }
  return a;
}

/**
 * What the caller is prepared to read:
 * - html:   pages to audit (text/html, application/xhtml+xml)
 * - xml:    sitemaps (application/xml, text/xml, +xml)
 * - robots: robots.txt (text/plain; anything else is read as text too, as crawlers do)
 * - status: link/image checks — only the status and redirect chain matter, the body is never read
 * - image:  crawl probes that measure an image (og:image) — only the first MAX_IMAGE_HEAD_BYTES, returned as `raw`
 * - resource: a request of a page being rendered — any content type, the decoded body returned as `raw`
 */
export type FetchAccept = "html" | "xml" | "sitemap" | "robots" | "status" | "image" | "resource";

export interface FetchOptions {
  accept: FetchAccept;
  /** HEAD is only used for `status`; servers that reject it are retried with GET. */
  method?: "GET" | "HEAD";
  signal?: AbortSignal;
  /**
   * When false, a 3xx is returned as the result (with `location`) instead of being followed, so the caller can
   * schedule the target as its own URL. Default true (legacy engine, verifier).
   */
  followRedirects?: boolean;
  /** Overrides for crawler v2 profiles; defaults are the legacy values. */
  timeoutMs?: number;
  maxBytes?: number;
  userAgent?: string;
  /** Extra request headers (crawler v2 basic auth). Sent only while a request stays on its first URL's origin. */
  headers?: Record<string, string>;
}

export interface FetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirectChain: RedirectHop[];
  contentType: string;
  /** False when the response's content type is not the one requested; the body is then empty. */
  contentTypeAccepted: boolean;
  /** Empty for non-2xx responses, `status` fetches and unaccepted content types. */
  body: string;
  bytes: number;
  truncated: boolean;
  /** Lower-cased response headers that rules use. */
  headers: Record<string, string>;
  /** Response time of the final hop, in ms. */
  elapsedMs: number;
  /** With `followRedirects: false`: the 3xx Location resolved against the request URL (not yet validated). */
  location?: string;
  /** `image` fetches: the first bytes of the body, undecoded. `resource` fetches: the body (content-decoded). */
  raw?: Buffer;
  /** The method of the request that produced this response: GET when a refused HEAD was retried. */
  method?: "GET" | "HEAD";
}

/**
 * Injected everywhere a page is retrieved, so the crawler, verifier and sample site share one contract.
 * Non-2xx responses are results, not errors. Throws SafeFetchError for blocked, unreachable or timed-out URLs.
 */
export type Fetcher = (url: string, opts: FetchOptions) => Promise<FetchResult>;

const TIMEOUT_ERROR_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT"]);
// Node's TLS and OpenSSL certificate errors (e.g. DEPTH_ZERO_SELF_SIGNED_CERT, CERT_HAS_EXPIRED, ERR_TLS_CERT_ALTNAME_INVALID).
const TLS_ERROR_CODE = /^(ERR_TLS_|ERR_SSL_|CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|HOSTNAME_MISMATCH$)/;

/** A transport failure worth its own error code, from the `code` of the error or any of its causes. */
export function classifyTransportError(e: unknown): { code: "TLS" | "TIMEOUT"; detail: string } | null {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string") {
      if (TLS_ERROR_CODE.test(code)) return { code: "TLS", detail: code };
      if (TIMEOUT_ERROR_CODES.has(code)) return { code: "TIMEOUT", detail: code };
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

function findSafeFetchError(e: unknown): SafeFetchError | null {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof SafeFetchError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

const ACCEPT_HEADER: Record<FetchAccept, string> = {
  html: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
  xml: "application/xml,text/xml;q=0.9,*/*;q=0.1",
  robots: "text/plain,*/*;q=0.1",
  sitemap: "application/xml,text/xml;q=0.9,application/gzip;q=0.8,*/*;q=0.1",
  status: "*/*",
  image: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/*;q=0.8,*/*;q=0.1",
  resource: "*/*",
};
const CONTENT_TYPES: Record<FetchAccept, RegExp> = {
  html: /text\/html|application\/xhtml\+xml/i,
  xml: /[/+]xml\b/i,
  robots: /./, // robots.txt is read as text whatever it claims to be
  // Gzipped sitemaps are often served as application/gzip, x-gzip or octet-stream.
  sitemap: /[/+]xml\b|gzip|octet-stream/i,
  status: /./,
  image: /^image\//i,
  resource: /^/, // whatever the page asked for, even without a content type
};
const BYTE_CAP: Record<FetchAccept, number> = { html: MAX_BYTES, xml: MAX_XML_BYTES, sitemap: MAX_SITEMAP_BYTES, robots: MAX_TEXT_BYTES, status: 0, image: MAX_IMAGE_HEAD_BYTES, resource: MAX_RESOURCE_BYTES };

/**
 * Build a fetcher with SSRF guards: every hop (the first request and each redirect) is re-validated, resolved once,
 * checked against `policy.isBlocked`, and connected to that pinned address. Redirects are followed manually.
 */
export function createSafeFetch(policy: FetchPolicy = DEFAULT_POLICY): Fetcher {
  return (input, opts) => fetchWithPolicy(input, opts, policy);
}

/** Fetch a public URL with SSRF guards, manual redirect validation, timeout and size cap. */
export function safeFetch(input: string, opts: FetchOptions): Promise<FetchResult> {
  return fetchWithPolicy(input, opts, DEFAULT_POLICY);
}

async function fetchWithPolicy(input: string, opts: FetchOptions, policy: FetchPolicy): Promise<FetchResult> {
  let url = validateTargetUrl(input, policy);
  const requestedUrl = url.toString();
  const firstOrigin = url.origin;
  const redirectChain: RedirectHop[] = [];
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  let method = opts.accept === "status" ? (opts.method ?? "HEAD") : "GET";

  try {
    for (let hop = 0; ; hop++) {
      // One lookup per hop. If a validated address refuses the connection, try the next one from the
      // same answer; never re-resolve mid-hop, so a changed DNS answer cannot slip in.
      const ips = await resolvePinned(url, policy);
      let started = Date.now();
      let res: Awaited<ReturnType<typeof fetch>> | undefined;
      for (let i = 0; !res; i++) {
        started = Date.now();
        try {
          res = await fetch(url, {
            method,
            redirect: "manual",
            dispatcher: pinnedAgent(url.hostname, ips[i], policy.ca),
            signal,
            headers: {
              ...(opts.headers && url.origin === firstOrigin ? opts.headers : {}),
              "user-agent": opts.userAgent ?? USER_AGENT,
              accept: ACCEPT_HEADER[opts.accept],
            },
          });
        } catch (e) {
          if (i + 1 >= ips.length || !isConnectError(e) || signal.aborted) throw e;
        }
      }

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        if (opts.followRedirects === false) {
          let location: string | undefined;
          try {
            location = new URL(res.headers.get("location")!, url).toString();
          } catch {
            location = undefined;
          }
          return {
            requestedUrl,
            finalUrl: url.toString(),
            status: res.status,
            redirectChain,
            contentType: res.headers.get("content-type") ?? "",
            contentTypeAccepted: false,
            headers: pickHeaders(res.headers),
            elapsedMs: Date.now() - started,
            body: "",
            bytes: 0,
            truncated: false,
            location,
          };
        }
        redirectChain.push({ url: url.toString(), status: res.status });
        if (hop >= MAX_REDIRECTS) {
          throw new SafeFetchError("TOO_MANY_REDIRECTS", `Stopped after ${MAX_REDIRECTS} redirects.`);
        }
        const next = validateTargetUrl(new URL(res.headers.get("location")!, url).toString(), policy);
        if (redirectChain.some((h) => h.url === next.toString())) {
          throw new SafeFetchError("TOO_MANY_REDIRECTS", `Redirect loop detected at ${next.toString()}.`);
        }
        url = next;
        continue;
      }

      // Some servers reject HEAD; ask again with GET rather than report a false error.
      if (method === "HEAD" && (res.status === 405 || res.status === 501 || res.status === 403)) {
        await res.body?.cancel();
        method = "GET";
        hop--;
        continue;
      }

      const contentType = res.headers.get("content-type") ?? "";
      const ok = res.status >= 200 && res.status < 300;
      const accepted = CONTENT_TYPES[opts.accept].test(contentType || (opts.accept === "robots" ? "text/plain" : ""));
      const base = {
        requestedUrl,
        finalUrl: url.toString(),
        status: res.status,
        redirectChain,
        contentType,
        contentTypeAccepted: accepted,
        headers: pickHeaders(res.headers, opts.accept === "resource" ? RESOURCE_HEADERS : RULE_HEADERS),
        method: method as "GET" | "HEAD",
        elapsedMs: Date.now() - started,
      };
      if (!ok || !accepted || opts.accept === "status") {
        await res.body?.cancel();
        return { ...base, body: "", bytes: 0, truncated: false };
      }
      const { bytes, truncated, buffer } = await readCapped(res.body, opts.maxBytes ?? BYTE_CAP[opts.accept]);
      if (opts.accept === "image" || opts.accept === "resource") return { ...base, body: "", raw: Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength), bytes, truncated };
      if (opts.accept === "sitemap" && isGzip(buffer)) {
        // A .gz sitemap without Content-Encoding arrives compressed; undici only decodes Content-Encoding.
        const unzipped = gunzipCapped(buffer, MAX_SITEMAP_BYTES);
        return { ...base, body: decode(unzipped.buffer, ""), bytes, truncated: truncated || unzipped.truncated };
      }
      return { ...base, body: decode(buffer, contentType), bytes, truncated };
    }
  } catch (e) {
    const known = findSafeFetchError(e);
    if (known) throw known;
    const transport = classifyTransportError(e);
    if (transport?.code === "TLS") throw new SafeFetchError("TLS", `TLS connection failed (${transport.detail}).`);
    if (transport?.detail === "UND_ERR_CONNECT_TIMEOUT") throw new SafeFetchError("TIMEOUT", `Could not connect within ${CONNECT_TIMEOUT_MS / 1000}s.`);
    if (transport || timeout.aborted || (e as Error)?.name === "TimeoutError") {
      throw new SafeFetchError("TIMEOUT", `No response within ${timeoutMs / 1000}s.`);
    }
    if ((e as Error)?.name === "AbortError") throw new SafeFetchError("NETWORK", "The request was cancelled.");
    throw new SafeFetchError("NETWORK", `Could not fetch the URL: ${(e as Error)?.message ?? "network error"}.`);
  }
}

export const liveFetcher: Fetcher = safeFetch;

/** Response headers kept on every result (and stored on snapshots) because a rule or the crawler reads them. */
const RULE_HEADERS = [
  "x-robots-tag",
  "link",
  "content-type",
  "content-language",
  "retry-after",
  // Security rules (SEC-004, SEC-005).
  "strict-transport-security",
  "x-content-type-options",
  "x-frame-options",
  "content-security-policy",
  // Image and resource sizes (IMG-005, IMG-006): Content-Range carries the total on a ranged GET.
  "content-length",
  "content-range",
  // Text compression (PERF-008).
  "content-encoding",
];

/** A rendered page's requests also keep their caching headers (PERF-009) and the CORS headers the browser checks. */
const RESOURCE_HEADERS = [...RULE_HEADERS, "cache-control", "expires", "etag", "last-modified", "access-control-allow-origin", "access-control-allow-credentials", "timing-allow-origin"];

function pickHeaders(h: { get(name: string): string | null }, names: readonly string[] = RULE_HEADERS): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of names) {
    const v = h.get(name);
    if (v !== null) out[name] = v.slice(0, 2000);
  }
  return out;
}

export async function readCapped(body: ReadableStream<Uint8Array> | null, cap: number) {
  if (!body) return { bytes: 0, truncated: false, buffer: new Uint8Array() };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > cap) {
      chunks.push(value.subarray(0, cap - bytes));
      bytes = cap;
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  const buffer = new Uint8Array(bytes);
  let offset = 0;
  for (const c of chunks) {
    buffer.set(c, offset);
    offset += c.byteLength;
  }
  return { bytes, truncated, buffer };
}

const isGzip = (b: Uint8Array) => b.length >= 2 && b[0] === 0x1f && b[1] === 0x8b;

/**
 * Gunzip with an output cap. A stream cut off mid-way (e.g. by the download cap) yields its readable prefix, flagged
 * as truncated. Output over `cap` (beyond the sitemaps.org 50 MB limit) or corrupt data yields an empty, truncated body.
 */
export function gunzipCapped(buffer: Uint8Array, cap: number): { buffer: Uint8Array; truncated: boolean } {
  try {
    return { buffer: gunzipSync(buffer, { maxOutputLength: cap }), truncated: false };
  } catch {
    try {
      return { buffer: gunzipSync(buffer, { maxOutputLength: cap, finishFlush: 2 /* Z_SYNC_FLUSH */ }), truncated: true };
    } catch {
      return { buffer: new Uint8Array(), truncated: true };
    }
  }
}

function decode(buffer: Uint8Array, contentType: string): string {
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

/** The certificate a host presents, read by a TLS handshake alone (SEC-003). */
export interface PeerCertificateInfo {
  subject: string | null;
  issuer: string | null;
  /** ISO timestamps. */
  validFrom: string;
  validTo: string;
  /** DNS names in subjectAltName. */
  altNames: string[];
  /** True when the chain verifies against the trusted roots for this hostname. */
  authorized: boolean;
  /** OpenSSL's reason when `authorized` is false (e.g. CERT_HAS_EXPIRED). */
  authorizationError: string | null;
}

export type PeerCertReader = (url: string, opts?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<PeerCertificateInfo>;

const certName = (x: PeerCertificate["subject"] | undefined) => {
  const v = x ? (x.CN ?? x.O ?? null) : null;
  return Array.isArray(v) ? v.join(", ") : v;
};

/**
 * Read an https URL's server certificate with the same SSRF guards as a fetch: the URL is validated, the host resolved
 * once and every address checked, and the socket connects to that pinned address with the hostname as SNI. The
 * handshake does not reject an invalid chain, so an expired or mismatched certificate can still be read and reported;
 * nothing is written on the socket (no HTTP request), and it is closed right after the handshake.
 */
export function createPeerCertReader(policy: FetchPolicy = DEFAULT_POLICY): PeerCertReader {
  return async (input, opts = {}) => {
    const url = validateTargetUrl(input, policy);
    if (url.protocol !== "https:") throw new SafeFetchError("INVALID_URL", "Only https:// URLs have a certificate to read.");
    const ips = await resolvePinned(url, policy);
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const timeoutMs = opts.timeoutMs ?? CONNECT_TIMEOUT_MS;
    for (let i = 0; ; i++) {
      try {
        return await handshake(ips[i], Number(url.port || 443), isIP(host) ? undefined : host, policy.ca, timeoutMs, opts.signal);
      } catch (e) {
        if (i + 1 >= ips.length || !isConnectError(e) || opts.signal?.aborted) {
          const known = findSafeFetchError(e);
          if (known) throw known;
          if ((e as { code?: string })?.code === "ETIMEDOUT") throw new SafeFetchError("TIMEOUT", `No TLS handshake within ${timeoutMs / 1000}s.`);
          throw new SafeFetchError("NETWORK", `Could not complete a TLS handshake: ${(e as Error)?.message ?? "network error"}.`);
        }
      }
    }
  };
}

function handshake(ip: string, port: number, servername: string | undefined, ca: string[] | undefined, timeoutMs: number, signal?: AbortSignal): Promise<PeerCertificateInfo> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const socket = tlsConnect({ host: ip, port, servername, rejectUnauthorized: false, ALPNProtocols: ["http/1.1"], ...caContext(ca) });
    const finish = (err: unknown, value?: PeerCertificateInfo) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      if (err) reject(err);
      else resolve(value!);
    };
    const onAbort = () => finish(new SafeFetchError("NETWORK", "The request was cancelled."));
    const timer = setTimeout(() => finish(Object.assign(new Error("handshake timed out"), { code: "ETIMEDOUT" })), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("error", (e) => finish(e));
    socket.once("secureConnect", () => {
      const c = socket.getPeerCertificate();
      if (!c || !c.valid_to) return finish(new SafeFetchError("TLS", "The server presented no certificate."));
      const err = socket.authorizationError as unknown;
      finish(null, {
        subject: certName(c.subject),
        issuer: certName(c.issuer),
        validFrom: new Date(c.valid_from).toISOString(),
        validTo: new Date(c.valid_to).toISOString(),
        altNames: (c.subjectaltname ?? "").split(/,\s*/).filter((x) => x.startsWith("DNS:")).map((x) => x.slice(4)),
        authorized: socket.authorized,
        authorizationError: err ? String((err as { code?: string }).code ?? err) : null,
      });
    });
  });
}
