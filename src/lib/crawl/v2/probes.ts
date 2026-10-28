// Crawl-level probes (docs/PHASE-2.md "Probes"): a fixed, small set of requests made once per crawl, after the last
// URL and before the crawl is marked completed, so site rules can judge what no crawled page shows. Every probe
// goes through the crawl's fetcher (SSRF guards) inside its host throttle, is stored in crawls.probes, and is not
// charged to the URL budget. A probe is recorded as started before its request; a resumed crawl never re-sends it.
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { SafeFetchError, type FetchOptions, type FetchResult } from "../../fetch/safe-fetch";
import { imageSize } from "../../snapshot/image-size";
import { MAX_OG_IMAGE_PROBES, resolveOgImage, type ProbeKind, type ProbeRecord } from "../../rules/probe-types";

/** llms.txt kept for AIS-003, at most. */
export const LLMS_TXT_KEEP_CHARS = 8 * 1024;

export interface ProbeContext {
  db: Db;
  crawlId: string;
  origin: string;
  /** Probes already in crawls.probes (a resumed crawl). */
  existing: ProbeRecord[];
  request(url: string, o: Omit<FetchOptions, "signal" | "timeoutMs" | "userAgent">): Promise<FetchResult>;
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
  // Keep an explicit port only for plain-http origins (local fixtures); default ports follow the scheme.
  if (u.protocol === "https:") scheme.port = "";
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

async function save(ctx: ProbeContext, list: ProbeRecord[]) {
  await ctx.db.execute(sql`update crawls set probes = ${JSON.stringify(list)}::jsonb where id = ${ctx.crawlId}::uuid`);
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
        list.push({ kind: p.kind, url: p.url, started: true, status: null, skipped: `over the cap of ${MAX_OG_IMAGE_PROBES} og:image probes per crawl` });
      }
      continue;
    }
    const at = byKey.get(key(p));
    if (at !== undefined) {
      // Started by an earlier run that stopped before the response was stored: never re-send it.
      const prev = list[at];
      if (prev.status === null && !prev.error && !prev.skipped) list[at] = { ...prev, skipped: "interrupted before the response was stored" };
      continue;
    }
    if (ctx.signal.aborted) {
      await save(ctx, list);
      return false;
    }
    const rec: ProbeRecord = { kind: p.kind, url: p.url, started: true, status: null };
    byKey.set(key(p), list.length);
    list.push(rec);
    await save(ctx, list);
    try {
      const res = await ctx.request(p.url, p.opts);
      rec.status = res.status;
      if (res.contentType) rec.contentType = res.contentType;
      if (res.location) rec.location = res.location;
      if (p.kind === "llms_txt" && res.status === 200) rec.body = res.body.slice(0, LLMS_TXT_KEEP_CHARS);
      if (p.kind === "og_image" && res.status === 200 && res.raw) {
        const size = imageSize(res.raw);
        if (size) Object.assign(rec, { width: size.width, height: size.height });
      }
    } catch (e) {
      if (ctx.signal.aborted && !(e instanceof SafeFetchError && e.code !== "NETWORK")) {
        // Stopped mid-request: leave it "started"; the resumed run records it as interrupted.
        await save(ctx, list);
        return false;
      }
      rec.error = e instanceof SafeFetchError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: String((e as Error)?.message ?? e) };
    }
    await save(ctx, list);
    ctx.log("crawl.probe", { crawlId: ctx.crawlId, kind: rec.kind, url: rec.url, status: rec.status, error: rec.error?.code });
  }
  await save(ctx, list);
  return true;
}
