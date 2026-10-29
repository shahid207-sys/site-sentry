// Crawl-level probes (docs/PHASE-2.md "Probes"): a fixed, small set of requests made once per crawl, after the last
// URL and before the crawl is marked completed, so site rules can judge what no crawled page shows. Every probe
// goes through the crawl's fetcher (SSRF guards) inside its host throttle, is stored in crawls.probes, and is not
// charged to the URL budget. Probes of the crawled host obey its robots.txt (a disallowed one is recorded as
// skipped). A probe is queued until it holds a throttle slot, then recorded as started before its request; a
// resumed crawl sends a queued probe and never re-sends a started one.
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { SafeFetchError, type FetchOptions, type FetchResult, type PeerCertReader } from "../../fetch/safe-fetch";
import { isAllowed, parseRobots } from "../robots";
import { imageSize } from "../../snapshot/image-size";
import { exposedFileMatch, MAX_OG_IMAGE_PROBES, resolveOgImage, type ProbeKind, type ProbeRecord } from "../../rules/probe-types";

/** llms.txt kept for AIS-003, at most. */
export const LLMS_TXT_KEEP_CHARS = 8 * 1024;
/** Bytes read of /.env and /.git/HEAD to judge their signature (the body is then dropped). */
export const EXPOSED_FILE_READ_BYTES = 64 * 1024;

export interface ProbeContext {
  db: Db;
  crawlId: string;
  origin: string;
  /** Probes already in crawls.probes (a resumed crawl). */
  existing: ProbeRecord[];
  /** Wait for a slot in the crawl's host throttle (rejects when the crawl is stopping). */
  acquire(): Promise<string>;
  release(slot: string): Promise<void>;
  /** Send a request in a slot already held; the slot is released when it returns. */
  request(url: string, o: Omit<FetchOptions, "signal" | "timeoutMs" | "userAgent">, slot: string): Promise<FetchResult>;
  /**
   * Why the crawl's own robots.txt forbids this URL on the crawled host, or null; other hosts get null unless
   * `asOwnHost` (another host whose robots.txt redirects to the crawl's own, which then applies to it).
   */
  robotsBlocked(url: string, asOwnHost?: boolean): string | null;
  /**
   * Reads a host's certificate by TLS handshake (SSRF-guarded, nothing written); called inside a held slot. Without it
   * (tests with a fake fetcher) no tls_cert probe is planned.
   */
  peerCert?: PeerCertReader;
  /** robots.txt user-agent token the crawl obeys. */
  robotsToken: string;
  /** Aborted when the crawl is stopping; remaining probes are left for the resumed run. */
  signal: AbortSignal;
  log(event: string, data?: Record<string, unknown>): void;
}

interface Planned {
  kind: ProbeKind;
  url: string;
  opts: Omit<FetchOptions, "signal" | "timeoutMs" | "userAgent">;
}

/** The other scheme, and the www / non-www host, of the start page. null when there is no such variant (IP hosts). */
export function hostVariants(origin: string): { scheme: string; www: string | null } {
  const u = new URL("/", origin);
  const scheme = new URL(u);
  scheme.protocol = u.protocol === "https:" ? "http:" : "https:";
  // An explicit port is kept on both schemes (a local fixture serves both on one port); a default port follows the scheme.
  const isIp = /^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.includes(":") || u.hostname.startsWith("[");
  let www: string | null = null;
  if (!isIp && u.hostname.includes(".")) {
    const w = new URL(u);
    w.hostname = u.hostname.startsWith("www.") ? u.hostname.slice(4) : `www.${u.hostname}`;
    www = w.toString();
  }
  return { scheme: scheme.toString(), www };
}

async function plan(ctx: ProbeContext): Promise<Planned[]> {
  const home = new URL("/", ctx.origin).toString();
  const v = hostVariants(ctx.origin);
  const noFollow = { accept: "status" as const, method: "GET" as const, followRedirects: false };
  const out: Planned[] = [{ kind: "home_scheme", url: v.scheme, opts: noFollow }];
  if (v.www) out.push({ kind: "home_www", url: v.www, opts: noFollow });

  // The icon the home page declares, else /favicon.ico.
  const r = await ctx.db.execute(sql`select s.facts->'icons' as icons from page_snapshots s join crawl_urls u on u.id = s.url_id
    where u.crawl_id = ${ctx.crawlId}::uuid and u.normalised_url = ${home} and s.status_code = 200 limit 1`);
  const icons = ((r.rows[0] as { icons: string[] | null } | undefined)?.icons ?? []).filter((i) => /^https?:/i.test(i));
  out.push({ kind: "favicon", url: icons[0] ?? new URL("/favicon.ico", ctx.origin).toString(), opts: { accept: "status", method: "GET" } });
  out.push({ kind: "llms_txt", url: new URL("/llms.txt", ctx.origin).toString(), opts: { accept: "robots" } });
  // Exposed files (SEC-006): not followed, since a redirect is not the file.
  const exposed = { accept: "robots" as const, followRedirects: false, maxBytes: EXPOSED_FILE_READ_BYTES };
  out.push({ kind: "env_file", url: new URL("/.env", ctx.origin).toString(), opts: exposed });
  out.push({ kind: "git_head", url: new URL("/.git/HEAD", ctx.origin).toString(), opts: exposed });
  if (ctx.peerCert && new URL(ctx.origin).protocol === "https:") out.push({ kind: "tls_cert", url: home, opts: { accept: "status" } });

  // Distinct og:image URLs in crawl order, resolved exactly as META-017 resolves them.
  const imgs = await ctx.db.execute(sql`select u.normalised_url as url, s.facts->'og'->>'image' as image from page_snapshots s join crawl_urls u on u.id = s.url_id
    where s.crawl_id = ${ctx.crawlId}::uuid and s.status_code = 200 and s.facts->'og'->>'image' is not null order by s.id`);
  const seen = new Set<string>();
  for (const row of imgs.rows as { url: string; image: string }[]) {
    const img = resolveOgImage(row.image, row.url);
    if (img) seen.add(img);
  }
  for (const url of seen) out.push({ kind: "og_image", url, opts: { accept: "image" } }); // past the cap: recorded as skipped
  return out;
}

const key = (p: { kind: ProbeKind; url: string }) => `${p.kind} ${p.url}`;

/** robots.txt of another host is kept up to this many characters to decide its probes (Google reads 500 KiB). */
export const ROBOTS_KEEP_CHARS = 64 * 1024;
/** Transport failures that mean the host does not answer at all: the probe would fail the same way, so it is recorded
 * as that error (the variant serves nothing) instead of being skipped. An HTTP 5xx or a timeout is not this. */
const NO_ANSWER = new Set(["DNS_FAILED", "TLS", "NETWORK", "BLOCKED_HOST"]);

type RobotsVerdict = { allowed: true } | { allowed: false; reason: string } | { noAnswer: { code: string; message: string } };

/** RFC 9309 verdict for `url` from a stored robots_txt record. */
function verdictFrom(rec: ProbeRecord, url: string, token: string): RobotsVerdict {
  if (rec.error && NO_ANSWER.has(rec.error.code)) return { noAnswer: rec.error };
  if (rec.status === null) return { allowed: false, reason: `${rec.url} could not be read${rec.error ? ` (${rec.error.message})` : ""}; treated as a full disallow (RFC 9309 §2.3.1.4)` };
  if (rec.status >= 200 && rec.status < 300) {
    const d = isAllowed(parseRobots(rec.robotsBody ?? ""), token, url);
    return d.allowed ? { allowed: true } : { allowed: false, reason: `${rec.url}: ${d.matchedRule ?? "rule"} applies to ${token}` };
  }
  if (rec.status >= 400 && rec.status < 500) return { allowed: true };
  return { allowed: false, reason: `${rec.url} returned ${rec.status}; treated as a full disallow (RFC 9309 §2.3.1.4)` };
}

async function save(ctx: ProbeContext, list: ProbeRecord[]) {
  await ctx.db.execute(sql`update crawls set probes = ${JSON.stringify(list)}::jsonb where id = ${ctx.crawlId}::uuid`);
}

function upsert(list: ProbeRecord[], byKey: Map<string, number>, rec: ProbeRecord): ProbeRecord {
  const at = byKey.get(key(rec));
  if (at !== undefined) list[at] = rec;
  else {
    byKey.set(key(rec), list.length);
    list.push(rec);
  }
  return rec;
}

/** Send one probe: queued until it holds a throttle slot, then started, then its response stored. Null when the crawl
 * started stopping first (a queued probe stays unsent; one cut off mid-request stays "started"). */
async function sendProbe(ctx: ProbeContext, list: ProbeRecord[], byKey: Map<string, number>, p: Planned): Promise<ProbeRecord | null> {
  const at = byKey.get(key(p));
  const rec = upsert(list, byKey, at !== undefined ? list[at] : { kind: p.kind, url: p.url, started: false, status: null });
  let slot: string;
  try {
    slot = await ctx.acquire();
  } catch (e) {
    if (!ctx.signal.aborted) throw e;
    await save(ctx, list);
    return null;
  }
  rec.started = true;
  try {
    await save(ctx, list);
  } catch (e) {
    await ctx.release(slot);
    throw e;
  }
  if (p.kind === "tls_cert") return sendCertProbe(ctx, list, rec, slot);
  try {
    const res = await ctx.request(p.url, p.opts, slot);
    rec.status = res.status;
    if (res.contentType) rec.contentType = res.contentType;
    if (res.location) rec.location = res.location;
    if (p.kind === "llms_txt" && res.status === 200) rec.body = res.body.slice(0, LLMS_TXT_KEEP_CHARS);
    if (p.kind === "robots_txt" && res.status >= 200 && res.status < 300) rec.robotsBody = res.body.slice(0, ROBOTS_KEEP_CHARS);
    // Only the match is kept; the body (possibly real secrets) is dropped here.
    if (p.kind === "env_file" || p.kind === "git_head") rec.secret = res.status === 200 ? exposedFileMatch(p.kind, res.body, res.contentType) : null;
    if (p.kind === "og_image" && res.status === 200 && res.raw) {
      const size = imageSize(res.raw);
      if (size) Object.assign(rec, { width: size.width, height: size.height });
    }
  } catch (e) {
    if (ctx.signal.aborted && !(e instanceof SafeFetchError && e.code !== "NETWORK")) {
      // Stopped mid-request: leave it "started"; the resumed run records it as interrupted.
      await save(ctx, list);
      return null;
    }
    rec.error = e instanceof SafeFetchError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: String((e as Error)?.message ?? e) };
  }
  await save(ctx, list);
  ctx.log("crawl.probe", { crawlId: ctx.crawlId, kind: rec.kind, url: rec.url, status: rec.status, error: rec.error?.code });
  return rec;
}

/** The tls_cert probe: a handshake inside the held slot, released here (no HTTP request, so no throttle outcome). */
async function sendCertProbe(ctx: ProbeContext, list: ProbeRecord[], rec: ProbeRecord, slot: string): Promise<ProbeRecord | null> {
  try {
    rec.cert = await ctx.peerCert!(rec.url, { signal: ctx.signal });
  } catch (e) {
    if (ctx.signal.aborted) {
      await ctx.release(slot);
      await save(ctx, list);
      return null;
    }
    rec.error = e instanceof SafeFetchError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: String((e as Error)?.message ?? e) };
  }
  await ctx.release(slot);
  await save(ctx, list);
  ctx.log("crawl.probe", { crawlId: ctx.crawlId, kind: rec.kind, url: rec.url, validTo: rec.cert?.validTo, error: rec.error?.code });
  return rec;
}

/** A robots_txt probe record for `url`: the stored one, or sent now. Null when the crawl started stopping first. */
async function robotsRecord(ctx: ProbeContext, list: ProbeRecord[], byKey: Map<string, number>, url: string, follow: boolean): Promise<ProbeRecord | null> {
  const r = list.find((x) => x.kind === "robots_txt" && x.url === url);
  if (!r || (!r.started && !r.skipped)) return sendProbe(ctx, list, byKey, { kind: "robots_txt", url, opts: { accept: "robots", followRedirects: follow } });
  if (r.started && r.status === null && !r.error) r.error = { code: "INTERRUPTED", message: "interrupted before the response was stored" };
  return r;
}

/**
 * RFC 9309 verdict for a probe on another host. Its robots.txt is read without following redirects: a www or scheme
 * twin usually redirects to the crawl's own robots.txt, which the crawl already holds, so its rules apply and the
 * file is not requested again. Any other target is read as its own robots_txt probe (redirects followed).
 */
async function otherHostRobots(ctx: ProbeContext, list: ProbeRecord[], byKey: Map<string, number>, robotsUrl: string, probeUrl: string): Promise<RobotsVerdict | null> {
  const r = await robotsRecord(ctx, list, byKey, robotsUrl, false);
  if (!r) return null;
  if (r.status === null || r.status < 300 || r.status >= 400 || !r.location) return verdictFrom(r, probeUrl, ctx.robotsToken);
  const target = new URL(r.location, robotsUrl).toString();
  if (target === new URL("/robots.txt", ctx.origin).toString()) {
    const why = ctx.robotsBlocked(probeUrl, true);
    return why ? { allowed: false, reason: `${robotsUrl} redirects to ${target}: ${why}` } : { allowed: true };
  }
  const t = await robotsRecord(ctx, list, byKey, target, true);
  return t && verdictFrom(t, probeUrl, ctx.robotsToken);
}

/** Run every probe not yet started. Returns false when the crawl started stopping before all were sent. */
export async function runProbes(ctx: ProbeContext): Promise<boolean> {
  const list = [...ctx.existing];
  const byKey = new Map(list.map((p, i) => [key(p), i]));
  const planned = await plan(ctx);
  let ogCount = 0;
  for (const p of planned) {
    if (p.kind === "og_image" && ++ogCount > MAX_OG_IMAGE_PROBES) {
      if (!byKey.has(key(p))) {
        byKey.set(key(p), list.length);
        list.push({ kind: p.kind, url: p.url, started: false, status: null, skipped: `over the cap of ${MAX_OG_IMAGE_PROBES} og:image probes per crawl`, skipCode: "over_cap" });
      }
      continue;
    }
    const at = byKey.get(key(p));
    const prev = at === undefined ? undefined : list[at];
    if (prev?.started) {
      // Sent by an earlier run that stopped before the response was stored: never re-send it.
      if (prev.status === null && !prev.error && !prev.skipped) list[at!] = { ...prev, skipped: "interrupted before the response was stored", skipCode: "interrupted" };
      continue;
    }
    if (prev?.skipped || prev?.error) continue;
    if (ctx.signal.aborted) {
      await save(ctx, list);
      return false;
    }
    // robots.txt of the probe's own host: the crawl's for the crawled host, else read once per host (itself a probe).
    let verdict: RobotsVerdict;
    if (new URL(p.url).host === new URL(ctx.origin).host) {
      const why = ctx.robotsBlocked(p.url);
      verdict = why ? { allowed: false, reason: why } : { allowed: true };
    } else {
      const v = await otherHostRobots(ctx, list, byKey, new URL("/robots.txt", p.url).toString(), p.url);
      if (!v) return false;
      verdict = v;
    }
    if ("noAnswer" in verdict) {
      // The host does not answer at all: that is the probe's answer too.
      const rec: ProbeRecord = { kind: p.kind, url: p.url, started: false, status: null, error: verdict.noAnswer };
      upsert(list, byKey, rec);
      await save(ctx, list);
      continue;
    }
    if (!verdict.allowed) {
      // The crawl obeys robots.txt for probes too; rules that need this probe report inconclusive.
      upsert(list, byKey, { kind: p.kind, url: p.url, started: false, status: null, skipped: `blocked by robots.txt: ${verdict.reason}`, skipCode: "probe_skipped_robots" });
      await save(ctx, list);
      continue;
    }
    if (!(await sendProbe(ctx, list, byKey, p))) return false;
  }
  await save(ctx, list);
  return true;
}
