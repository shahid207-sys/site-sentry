import { lookup as dnsLookup, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup as dnsLookupAsync } from "node:dns/promises";
import { isIP } from "node:net";
import type { ReadableStream } from "node:stream/web";
import { Agent, fetch } from "undici";
import { isBlockedIp } from "./ip-guard";
import type { RedirectHop } from "../audit/types";

export const MAX_REDIRECTS = 5;
export const MAX_BYTES = 2 * 1024 * 1024; // 2 MB of HTML is plenty for head-level checks
export const TIMEOUT_MS = 10_000;
const ALLOWED_PORTS = new Set(["", "80", "443"]);
const USER_AGENT = "SiteSentryBot/0.1 (+technical SEO audit)";

export type SafeFetchErrorCode =
  | "INVALID_URL"
  | "BLOCKED_HOST"
  | "DNS_FAILED"
  | "TIMEOUT"
  | "TOO_MANY_REDIRECTS"
  | "HTTP_ERROR"
  | "NOT_HTML"
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

/** Parse and validate user input. Adds https:// when no scheme is given. Pure — no DNS. */
export function validateTargetUrl(input: string): URL {
  const trimmed = input.trim();
  if (!trimmed) throw new SafeFetchError("INVALID_URL", "Enter a URL to audit.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new SafeFetchError("INVALID_URL", `"${input}" is not a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("INVALID_URL", "Only http:// and https:// URLs can be audited.");
  }
  if (url.username || url.password) {
    throw new SafeFetchError("INVALID_URL", "URLs containing credentials are not allowed.");
  }
  if (!ALLOWED_PORTS.has(url.port)) {
    throw new SafeFetchError("BLOCKED_HOST", "Only the standard ports 80 and 443 are allowed.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host.includes(".") && !isIP(host.replace(/^\[|\]$/g, ""))) {
    throw new SafeFetchError("BLOCKED_HOST", "Enter a public domain name (e.g. example.com).");
  }
  if (/(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/.test(host)) {
    throw new SafeFetchError("BLOCKED_HOST", "Local and internal hostnames cannot be audited.");
  }
  url.hash = "";
  return url;
}

/** Resolve the host and reject if ANY resolved address is non-public. */
async function assertPublicHost(url: URL): Promise<void> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedIp(host)) throw blockedError(host);
    return;
  }
  let addrs: LookupAddress[];
  try {
    addrs = await dnsLookupAsync(host, { all: true, verbatim: true });
  } catch {
    throw new SafeFetchError("DNS_FAILED", `Could not resolve ${host}.`);
  }
  if (addrs.length === 0) throw new SafeFetchError("DNS_FAILED", `Could not resolve ${host}.`);
  const bad = addrs.find((a) => isBlockedIp(a.address));
  if (bad) throw blockedError(host, bad.address);
}

function blockedError(host: string, ip?: string) {
  const detail = ip && ip !== host ? ` (${host} resolves to ${ip})` : "";
  return new SafeFetchError("BLOCKED_HOST", `Refusing to fetch a private or reserved address${detail}.`);
}

/**
 * DNS lookup used for the actual socket connection. Re-checks every address so a
 * DNS answer that changes between our pre-check and connect (DNS rebinding) is still refused.
 */
function guardedLookup(
  hostname: string,
  options: LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) {
  dnsLookup(hostname, { ...options, verbatim: true }, (err, address, family) => {
    if (err) return callback(err, "");
    const list = Array.isArray(address) ? address : [{ address, family }];
    const bad = list.find((a) => isBlockedIp(a.address));
    if (bad) return callback(blockedError(hostname, bad.address) as unknown as NodeJS.ErrnoException, "");
    if (Array.isArray(address)) callback(null, address);
    else callback(null, address, family);
  });
}

export const agent = new Agent({
  connect: { lookup: guardedLookup, timeout: TIMEOUT_MS },
  headersTimeout: TIMEOUT_MS,
  bodyTimeout: TIMEOUT_MS,
});

export interface SafeFetchResult {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirectChain: RedirectHop[];
  html: string;
  bytes: number;
  truncated: boolean;
}

function findSafeFetchError(e: unknown): SafeFetchError | null {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur; i++) {
    if (cur instanceof SafeFetchError) return cur;
    cur = (cur as { cause?: unknown }).cause;
  }
  return null;
}

/** Fetch a public HTML page with SSRF guards, manual redirect validation, timeout and size cap. */
export async function safeFetchHtml(input: string): Promise<SafeFetchResult> {
  let url = validateTargetUrl(input);
  const requestedUrl = url.toString();
  const redirectChain: RedirectHop[] = [];
  const signal = AbortSignal.timeout(TIMEOUT_MS);

  try {
    for (let hop = 0; ; hop++) {
      await assertPublicHost(url);
      const res = await fetch(url, {
        redirect: "manual",
        dispatcher: agent,
        signal,
        headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" },
      });

      if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
        await res.body?.cancel();
        redirectChain.push({ url: url.toString(), status: res.status });
        if (hop >= MAX_REDIRECTS) {
          throw new SafeFetchError("TOO_MANY_REDIRECTS", `Stopped after ${MAX_REDIRECTS} redirects.`);
        }
        url = validateTargetUrl(new URL(res.headers.get("location")!, url).toString());
        continue;
      }

      if (res.status < 200 || res.status >= 300) {
        await res.body?.cancel();
        throw new SafeFetchError("HTTP_ERROR", `The page responded with HTTP ${res.status}.`, res.status);
      }

      const contentType = res.headers.get("content-type") ?? "";
      if (!/text\/html|application\/xhtml\+xml/i.test(contentType)) {
        await res.body?.cancel();
        throw new SafeFetchError("NOT_HTML", `Expected an HTML page but got "${contentType || "no content-type"}".`);
      }

      const { bytes, truncated, buffer } = await readCapped(res.body);
      return {
        requestedUrl,
        finalUrl: url.toString(),
        status: res.status,
        redirectChain,
        html: decode(buffer, contentType),
        bytes,
        truncated,
      };
    }
  } catch (e) {
    const known = findSafeFetchError(e);
    if (known) throw known;
    if (signal.aborted || (e as Error)?.name === "TimeoutError" || (e as Error)?.name === "AbortError") {
      throw new SafeFetchError("TIMEOUT", `The page did not respond within ${TIMEOUT_MS / 1000}s.`);
    }
    throw new SafeFetchError("NETWORK", `Could not fetch the page: ${(e as Error)?.message ?? "network error"}.`);
  }
}

async function readCapped(body: ReadableStream<Uint8Array> | null) {
  if (!body) return { bytes: 0, truncated: false, buffer: new Uint8Array() };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.byteLength > MAX_BYTES) {
      chunks.push(value.subarray(0, MAX_BYTES - bytes));
      bytes = MAX_BYTES;
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

function decode(buffer: Uint8Array, contentType: string): string {
  const charset = contentType.match(/charset=["']?([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(charset ?? "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}
