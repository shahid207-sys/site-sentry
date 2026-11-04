// Postgres-backed frontier and URL states for crawler v2 (docs/SPEC.md "Crawler engine → Resumability").
//
// At-most-once fetch accounting, in three steps (see docs/CRAWLER-STATES.md):
//   1. reserve()       — one transaction claims up to N `discovered` rows with FOR UPDATE SKIP LOCKED and marks
//                        them `queued` under this worker's lease. Nothing has been sent, so an expired reservation
//                        is safely returned to `discovered`.
//   2. commitToSend()  — one small transaction per URL, immediately before the request: charges the budget and
//                        moves the row to `fetching` with a fresh claim token. A `fetching` row is never claimed again.
//   3. recordResult()  — one transaction writes the snapshot, the outgoing edges, the newly discovered URLs and
//                        the URL's terminal state, conditional on the claim token. If the token no longer matches,
//                        the whole transaction rolls back.
// sweep() turns expired `queued` rows back into `discovered` and expired `fetching` rows into `interrupted`.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import type { DiscoverySource, TerminalState, UrlState } from "./types";
import type { ExtractedHtml } from "../../snapshot/types";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Exec = Db | Tx;

export const DEFAULT_LEASE_MS = 60_000;
/**
 * Non-HTML answers per crawl (feeds, JSON, images and files linked as pages), counted apart from the page budget. Only
 * the answer shows what a URL is, so a fetch is charged as a page at commit and moved here when it comes back non-HTML.
 * Once this is spent, URLs that look non-HTML by extension are not requested; one that does not look it is only found
 * out by asking, and stays charged as a page. A crawl's `config.nonHtmlBudget` overrides it (tests).
 */
export const NON_HTML_BUDGET = 1_000;
/** A URL whose path ends in a file type that is not a page. */
const NON_HTML_PATH = String.raw`\.(webp|jpe?g|png|gif|svg|ico|avif|bmp|tiff?|pdf|zip|gz|rar|7z|mp3|mp4|m4a|webm|mov|avi|wav|ogg|woff2?|ttf|otf|eot|css|js|json|xml|rss|csv|docx?|xlsx?|pptx?)(\?.*)?$`;
const nonHtmlSpent = (k: string) => sql.raw(`(${k}.budget is not null and ${k}.non_html_fetches >= coalesce((${k}.config->>'nonHtmlBudget')::int, ${NON_HTML_BUDGET}))`);

export interface NewUrl {
  url: string;
  original: string;
  via: DiscoverySource;
  /** Link depth; null for URLs found only in sitemaps. */
  depth: number | null;
  redirectHops?: number;
  /** Set when the URL is terminal on arrival (out of scope, blocked by robots, rejected by normalisation). */
  state?: TerminalState;
  reason?: string;
}

export interface Edge {
  fromUrl: string;
  toUrl: string;
  via: string;
  anchor: string | null;
  rel: string | null;
  location: string | null;
  nofollow: boolean;
}

export interface ReservedUrl {
  id: number;
  url: string;
  depth: number | null;
  discoveredVia: DiscoverySource[];
  redirectHops: number;
}

export interface SnapshotRow {
  requestedUrl: string;
  finalUrl: string;
  statusCode: number;
  contentType: string;
  headers: Record<string, string>;
  bytes: number;
  truncated: boolean;
  elapsedMs: number;
  contentHash: string | null;
  outlinkCount: number;
  /** Set by the runner after the raw HTML is in the blob store. */
  rawHtmlKey: string | null;
  /** "stored", or "blob_missing" when the write failed after one retry; null when there was no HTML to store. */
  blobStatus: BlobStatus | null;
  /** Extracted page fields; null when the response had no HTML body (error status, non-HTML). */
  extracted: ExtractedHtml | null;
  extractMs: number;
}

export interface UrlResult {
  state: TerminalState;
  reason: string;
  statusCode?: number | null;
  contentType?: string | null;
  redirectTarget?: string | null;
  elapsedMs?: number | null;
  bytes?: number | null;
  snapshot?: SnapshotRow;
  /** Raw HTML to store before the result is recorded; never written to Postgres. */
  rawHtml?: string;
  newUrls?: NewUrl[];
  edges?: Edge[];
}

export class ClaimLostError extends Error {
  constructor(urlId: number) {
    super(`Claim on URL ${urlId} is no longer held; result discarded.`);
    this.name = "ClaimLostError";
  }
}

const rows = <T>(r: { rows: unknown[] }) => r.rows as T[];
/** Bind a JS array as one Postgres array parameter (a bare array in a `sql` template expands into a value list). */
const arr = (values: unknown[]) => sql.param(values);

/**
 * Insert or merge discovered URLs. A URL already present gains the new discovery source and keeps the smaller
 * depth; its state is unchanged. Input is merged per URL and sorted, so concurrent upserts lock rows in the same
 * order and cannot deadlock.
 */
export async function upsertUrls(db: Exec, crawlId: string, urls: NewUrl[]): Promise<void> {
  if (!urls.length) return;
  const merged = new Map<string, NewUrl & { vias: Set<string> }>();
  for (const u of urls) {
    const cur = merged.get(u.url);
    if (!cur) {
      merged.set(u.url, { ...u, vias: new Set([u.via]) });
      continue;
    }
    cur.vias.add(u.via);
    if (u.depth !== null && (cur.depth === null || u.depth < cur.depth)) cur.depth = u.depth;
    cur.redirectHops = Math.min(cur.redirectHops ?? 0, u.redirectHops ?? 0);
    // An active (crawlable) sighting wins over a terminal one: e.g. linked once in scope, once rejected.
    if (!u.state) {
      cur.state = undefined;
      cur.reason = undefined;
    }
  }
  const list = [...merged.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  for (let i = 0; i < list.length; i += 1000) {
    const chunk = list.slice(i, i + 1000);
    await db.execute(sql`
      insert into crawl_urls (crawl_id, url, normalised_url, state, reason, depth, discovered_via, redirect_hops)
      select ${crawlId}::uuid, u.original, u.url, coalesce(u.state, 'discovered'), u.reason, u.depth, string_to_array(u.vias, ','), u.hops
      from unnest(
        ${arr(chunk.map((u) => u.original))}::text[], ${arr(chunk.map((u) => u.url))}::text[], ${arr(chunk.map((u) => u.state ?? null))}::text[],
        ${arr(chunk.map((u) => u.reason ?? null))}::text[], ${arr(chunk.map((u) => u.depth))}::int[], ${arr(chunk.map((u) => [...u.vias].sort().join(",")))}::text[],
        ${arr(chunk.map((u) => u.redirectHops ?? 0))}::int[]
      ) as u(original, url, state, reason, depth, vias, hops)
      order by u.url
      on conflict (crawl_id, normalised_url) do update set
        discovered_via = (select array_agg(distinct v order by v) from unnest(crawl_urls.discovered_via || excluded.discovered_via) v),
        depth = least(crawl_urls.depth, excluded.depth),
        redirect_hops = least(crawl_urls.redirect_hops, excluded.redirect_hops),
        updated_at = now()`);
  }
}

export async function insertEdges(db: Exec, crawlId: string, edges: Edge[]): Promise<void> {
  for (let i = 0; i < edges.length; i += 1000) {
    const c = edges.slice(i, i + 1000);
    await db.execute(sql`
      insert into url_edges (crawl_id, from_url, to_url, via, anchor, rel, location, nofollow)
      select ${crawlId}::uuid, e.f, e.t, e.v, e.a, e.r, e.l, e.n
      from unnest(${arr(c.map((e) => e.fromUrl))}::text[], ${arr(c.map((e) => e.toUrl))}::text[], ${arr(c.map((e) => e.via))}::text[],
        ${arr(c.map((e) => e.anchor))}::text[], ${arr(c.map((e) => e.rel))}::text[], ${arr(c.map((e) => e.location))}::text[], ${arr(c.map((e) => e.nofollow))}::boolean[])
        as e(f, t, v, a, r, l, n)`);
  }
}

/**
 * Step 1: reserve up to `limit` crawlable URLs, breadth-first (smallest depth first, sitemap-only URLs last).
 * A URL is crawlable when its link depth is within `maxDepth`, or a seed or sitemap names it.
 */
export async function reserve(db: Db, crawlId: string, owner: string, limit: number, maxDepth: number | null, leaseMs = DEFAULT_LEASE_MS): Promise<ReservedUrl[]> {
  const res = await db.execute(sql`
    with c as (
      select id from crawl_urls
      where crawl_id = ${crawlId}::uuid and state = 'discovered'
        -- Once the budget is spent nothing more is handed out; the leftovers are finalised as budget_exhausted.
        and exists (select 1 from crawls k where k.id = ${crawlId}::uuid and (k.budget is null or k.fetches_committed < k.budget))
        -- Past the non-HTML budget, what looks non-HTML waits for finalizeUrls.
        and not (normalised_url ~* ${NON_HTML_PATH} and exists (select 1 from crawls k where k.id = ${crawlId}::uuid and ${nonHtmlSpent("k")}))
        and (${maxDepth}::int is null or depth is null or depth <= ${maxDepth}::int or discovered_via && array['seed','sitemap']::text[])
        -- Sitemap-only rows (null depth) wait until no row with a link depth is left to claim. Their children count
        -- from depth 0, so fetching one early would give pages that links do reach a lower depth than their real
        -- click depth, and LEAST would keep it.
        and (depth is not null or not exists (
          select 1 from crawl_urls a
          where a.crawl_id = ${crawlId}::uuid and a.state = 'discovered' and a.depth is not null
            and (${maxDepth}::int is null or a.depth <= ${maxDepth}::int or a.discovered_via && array['seed','sitemap']::text[])))
      order by depth nulls last, id
      -- Never more than the budget left after the URLs already reserved: the budget is charged at commit, and
      -- concurrent commits would otherwise decide which reserved URLs get the last slots (not breadth-first order).
      -- An expired reservation (a worker that died) holds no slot; commit still enforces the budget either way.
      limit (select case when k.budget is null then ${limit}::int
          else greatest(0, least(${limit}::int, k.budget - k.fetches_committed
            - (select count(*)::int from crawl_urls q where q.crawl_id = k.id and q.state = 'queued' and q.lease_until > now()))) end
        from crawls k where k.id = ${crawlId}::uuid)
      for update skip locked
    )
    update crawl_urls u set state = 'queued', lease_owner = ${owner}, lease_until = now() + ${leaseMs} * interval '1 millisecond', updated_at = now()
    from c where u.id = c.id
    returning u.id, u.normalised_url as url, u.depth, u.discovered_via, u.redirect_hops`);
  return rows<{ id: string | number; url: string; depth: number | null; discovered_via: DiscoverySource[]; redirect_hops: number }>(res)
    .map((r) => ({ id: Number(r.id), url: r.url, depth: r.depth, discoveredVia: r.discovered_via, redirectHops: r.redirect_hops }))
    .sort((a, b) => (a.depth ?? Infinity) - (b.depth ?? Infinity) || a.id - b.id);
}

export type CommitOutcome = { ok: true; token: string } | { ok: false; why: "budget" | "lost" | "stopped" };

/**
 * Step 2: charge the budget and mark the URL `fetching`. Only send the request after this returns ok.
 * Refuses (`stopped`) unless the crawl is `running`, so pause and cancel take effect before the next request.
 */
export async function commitToSend(db: Db, crawlId: string, urlId: number, owner: string, leaseMs = DEFAULT_LEASE_MS): Promise<CommitOutcome> {
  // A deadlock rolled the transaction back whole (nothing was charged or sent), so it is run again.
  for (let attempt = 1; ; attempt++) {
    try {
      return await commitOnce(db, crawlId, urlId, owner, leaseMs);
    } catch (e) {
      if (!isDeadlock(e) || attempt >= RECORD_ATTEMPTS) throw e;
    }
  }
}

async function commitOnce(db: Db, crawlId: string, urlId: number, owner: string, leaseMs: number): Promise<CommitOutcome> {
  const token = randomUUID();
  return db.transaction(async (tx) => {
    const mine = await tx.execute(sql`select id from crawl_urls where id = ${urlId} and state = 'queued' and lease_owner = ${owner} for update`);
    if (!mine.rows.length) return { ok: false, why: "lost" } as const;
    const charged = await tx.execute(sql`
      update crawls set fetches_committed = fetches_committed + 1, heartbeat_at = now()
      where id = ${crawlId}::uuid and status = 'running' and (budget is null or fetches_committed < budget) returning id`);
    if (!charged.rows.length) {
      await tx.execute(sql`update crawl_urls set state = 'discovered', lease_owner = null, lease_until = null, updated_at = now() where id = ${urlId}`);
      const crawl = await tx.execute(sql`select status from crawls where id = ${crawlId}::uuid`);
      const running = rows<{ status: string }>(crawl)[0]?.status === "running";
      return { ok: false, why: running ? "budget" : "stopped" } as const;
    }
    await tx.execute(sql`
      update crawl_urls set state = 'fetching', claim_token = ${token}, attempts = attempts + 1,
        lease_until = now() + ${leaseMs} * interval '1 millisecond', updated_at = now()
      where id = ${urlId}`);
    return { ok: true, token } as const;
  });
}

/** Count another request for a URL already in `fetching` (a deliberate retry after 429/503), under the same claim. */
export async function recordRetry(db: Db, urlId: number, token: string): Promise<void> {
  const r = await db.execute(sql`update crawl_urls set attempts = attempts + 1, updated_at = now() where id = ${urlId} and state = 'fetching' and claim_token = ${token} returning id`);
  if (!r.rows.length) throw new ClaimLostError(urlId);
}

/**
 * The server refused the request (429/503) and the crawl stopped before the retry: give the URL back to the frontier
 * so a resume requests it again, and refund its budget charge (it produced no page). Safe under at-most-once: the
 * server answered, and a refused request is retried anyway. Active rows carry no reason (crawl_urls_reason_ck); the
 * runner logs the requeue.
 */
export async function requeueRefused(db: Db, crawlId: string, urlId: number, token: string): Promise<void> {
  await db.transaction(async (tx) => {
    const r = await tx.execute(sql`update crawl_urls set state = 'discovered', reason = null, lease_owner = null, lease_until = null,
        claim_token = null, updated_at = now()
      where id = ${urlId} and state = 'fetching' and claim_token = ${token} returning id`);
    if (!r.rows.length) throw new ClaimLostError(urlId);
    await tx.execute(sql`update crawls set fetches_committed = greatest(0, fetches_committed - 1) where id = ${crawlId}::uuid`);
  });
}

/** Postgres aborted the transaction to break a lock cycle; it rolled back whole, so running it again is safe. */
export const isDeadlock = (e: unknown): boolean => {
  for (let x = e as { code?: string; cause?: unknown } | undefined, i = 0; x && i < 5; x = x.cause as typeof x, i++) if (x.code === "40P01") return true;
  return false;
};
export const RECORD_ATTEMPTS = 3;

/**
 * Step 3: write everything the fetch produced and the URL's terminal state, atomically. The pre-lock below orders
 * the rows that exist when it runs, but a linked URL another transaction inserts or commits after it is locked
 * later, out of that order, so a lock cycle stays possible under concurrency. Postgres then aborts one
 * transaction (40P01); it rolled back entirely and this worker still holds the claim, so it is run again.
 */
export async function recordResult(db: Db, crawlId: string, urlId: number, token: string, result: UrlResult): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await writeResult(db, crawlId, urlId, token, result);
    } catch (e) {
      if (!isDeadlock(e) || attempt >= RECORD_ATTEMPTS) throw e;
    }
  }
}

async function writeResult(db: Db, crawlId: string, urlId: number, token: string, result: UrlResult): Promise<void> {
  await db.transaction(async (tx) => {
    // Lock this URL's row and every existing row it links to in one global order (by URL) before writing any of
    // them. Otherwise two pages that link to each other, recorded at once, each hold their own row and wait for
    // the other's: a deadlock. New rows are inserted in the same order by upsertUrls.
    const linked = [...new Set((result.newUrls ?? []).map((u) => u.url))];
    await tx.execute(sql`select id from crawl_urls
      where id = ${urlId} or (crawl_id = ${crawlId}::uuid and normalised_url = any(${arr(linked)}::text[]))
      order by normalised_url for update`);
    const done = await tx.execute(sql`
      update crawl_urls set state = ${result.state}, reason = ${result.reason}, status_code = ${result.statusCode ?? null},
        content_type = ${result.contentType ?? null}, redirect_target = ${result.redirectTarget ?? null},
        elapsed_ms = ${result.elapsedMs ?? null}, bytes = ${result.bytes ?? null}, fetched_at = now(),
        lease_owner = null, lease_until = null, claim_token = null, updated_at = now()
      where id = ${urlId} and state = 'fetching' and claim_token = ${token}
      returning id`);
    if (!done.rows.length) throw new ClaimLostError(urlId);
    // Not a page: its charge moves to the non-HTML budget and the page budget gets the slot back.
    if (result.state === "non_html") {
      await tx.execute(sql`update crawls k set fetches_committed = greatest(0, fetches_committed - 1), non_html_fetches = non_html_fetches + 1
        where k.id = ${crawlId}::uuid and not ${nonHtmlSpent("k")}`);
    }
    const s = result.snapshot;
    if (s) {
      await insertSnapshot(tx, crawlId, urlId, s);
    }
    if (result.newUrls?.length) await upsertUrls(tx, crawlId, result.newUrls);
    if (result.edges?.length) await insertEdges(tx, crawlId, result.edges);
  });
}

const json = (v: unknown) => sql`${JSON.stringify(v)}::jsonb`;

export type BlobStatus = "stored" | "blob_missing";

async function insertSnapshot(tx: Exec, crawlId: string, urlId: number, s: SnapshotRow): Promise<void> {
  const x = s.extracted;
  await tx.execute(sql`
    insert into page_snapshots (crawl_id, url_id, requested_url, final_url, status_code, content_type, headers, raw_html_key, blob_status, bytes, truncated,
      elapsed_ms, content_hash, outlink_count, fetched_at, head, canonicals, robots, title, titles, description, descriptions, outline,
      main_text, word_count, language, links, images, json_ld, text_hash, simhash, template_fingerprint, template_shape, timings, facts)
    values (${crawlId}::uuid, ${urlId}, ${s.requestedUrl}, ${s.finalUrl}, ${s.statusCode}, ${s.contentType}, ${json(s.headers)}, ${s.rawHtmlKey}, ${s.blobStatus}, ${s.bytes}, ${s.truncated},
      ${s.elapsedMs}, ${s.contentHash}, ${s.outlinkCount}, now(), ${json(x?.head ?? [])}, ${json(x?.canonicals ?? [])}, ${x ? json(x.robots) : null},
      ${x?.titles[0] ?? null}, ${json(x?.titles ?? [])}, ${x?.descriptions[0] ?? null}, ${json(x?.descriptions ?? [])}, ${json(x?.outline ?? [])},
      ${x?.mainText ?? null}, ${x?.wordCount ?? null}, ${x ? json(x.language) : null}, ${json(x?.links ?? [])}, ${json(x?.images ?? [])}, ${json(x?.jsonLd ?? [])},
      ${x?.textHash ?? null}, ${x?.simhash ?? null}, ${x?.templateFingerprint ?? null}, ${x?.templateShape ? json(x.templateShape) : null}, ${json({ fetchMs: s.elapsedMs, extractMs: s.extractMs })}, ${x ? json(x.facts) : null})`);
}

/** Return this worker's unsent reservations to the frontier (pause, cancel, shutdown). */
export async function releaseReservations(db: Db, owner: string): Promise<number> {
  const r = await db.execute(sql`update crawl_urls set state = 'discovered', lease_owner = null, lease_until = null, updated_at = now()
    where lease_owner = ${owner} and state = 'queued' returning id`);
  return r.rows.length;
}

/**
 * Keep this worker's reservations and in-flight claims alive. SKIP LOCKED: a plain multi-row update locks rows in heap
 * order and waits on each, so it closed lock cycles with commitToSend and recordResult (which lock in URL order) and
 * Postgres aborted one of them (40P01). A row skipped here is locked by a transaction that is writing it right now
 * (and sets or clears its lease itself); the next renewal, a third of a lease later, covers it.
 */
export async function renewLeases(db: Db, owner: string, leaseMs = DEFAULT_LEASE_MS): Promise<void> {
  await db.execute(sql`update crawl_urls u set lease_until = now() + ${leaseMs} * interval '1 millisecond'
    from (select id from crawl_urls where lease_owner = ${owner} and state in ('queued', 'fetching') for update skip locked) c
    where u.id = c.id`);
}

export const INTERRUPTED_REASON = "The worker stopped after this request was committed and before its result was saved; not re-requested (at-most-once).";

/**
 * Recover after a worker died: unsent reservations return to the frontier; committed requests become `interrupted`.
 * By default only expired leases are touched. `force` ignores leases; only call it for a crawl whose runner lock you
 * hold, which proves no other process is working on it.
 */
export async function sweep(db: Db, crawlId?: string, opts: { force?: boolean } = {}): Promise<{ requeued: number; interrupted: number }> {
  if (opts.force && !crawlId) throw new Error("A forced sweep needs a crawl id.");
  const scope = crawlId ? sql`and crawl_id = ${crawlId}::uuid` : sql``;
  const expired = opts.force ? sql`` : sql`and lease_until < now()`;
  const requeued = await db.execute(sql`update crawl_urls set state = 'discovered', lease_owner = null, lease_until = null, updated_at = now()
    where state = 'queued' ${expired} ${scope} returning id`);
  const interrupted = await db.execute(sql`update crawl_urls set state = 'interrupted', reason = ${INTERRUPTED_REASON},
      lease_owner = null, lease_until = null, claim_token = null, updated_at = now()
    where state = 'fetching' ${expired} ${scope} returning id`);
  return { requeued: requeued.rows.length, interrupted: interrupted.rows.length };
}

/** Rows still active (not terminal) for a crawl. */
export async function activeCount(db: Db, crawlId: string): Promise<{ discovered: number; queued: number; fetching: number }> {
  const r = await db.execute(sql`select state, count(*)::int as n from crawl_urls where crawl_id = ${crawlId}::uuid and state in ('discovered','queued','fetching') group by state`);
  const out = { discovered: 0, queued: 0, fetching: 0 };
  for (const row of rows<{ state: keyof typeof out; n: number }>(r)) out[row.state] = row.n;
  return out;
}

/**
 * Give every remaining active URL its terminal state. Called once no worker holds a claim on the crawl.
 * Completed: URLs beyond the depth limit become `depth_exceeded`, the rest `budget_exhausted`. Cancelled: `cancelled`.
 * Failed (the run stopped with an error): `cancelled`, with a reason that says so.
 */
export async function finalizeUrls(db: Db, crawlId: string, outcome: "completed" | "cancelled" | "failed", maxDepth: number | null, budget: number | null): Promise<void> {
  await db.transaction(async (tx) => {
    if (outcome !== "completed") {
      const reason = outcome === "cancelled" ? "The crawl was cancelled before this URL was fetched." : "The crawl stopped with an error before this URL was fetched.";
      await tx.execute(sql`update crawl_urls set state = 'cancelled', reason = ${reason},
          lease_owner = null, lease_until = null, updated_at = now()
        where crawl_id = ${crawlId}::uuid and state in ('discovered', 'queued')`);
      return;
    }
    if (maxDepth !== null) {
      await tx.execute(sql`update crawl_urls set state = 'depth_exceeded',
          reason = 'Found only through links ' || depth || ' clicks from the start URL; this crawl follows links up to ' || ${maxDepth}::int || '.',
          updated_at = now()
        where crawl_id = ${crawlId}::uuid and state = 'discovered' and depth > ${maxDepth}::int and not (discovered_via && array['seed','sitemap']::text[])`);
    }
    await tx.execute(sql`update crawl_urls u set state = 'budget_exhausted',
        reason = 'The crawl''s non-HTML budget of ' || coalesce((k.config->>'nonHtmlBudget')::int, ${NON_HTML_BUDGET}) || ' was used up before this URL was fetched.',
        lease_owner = null, lease_until = null, updated_at = now()
      from crawls k
      where u.crawl_id = ${crawlId}::uuid and k.id = u.crawl_id and u.state in ('discovered', 'queued')
        and u.normalised_url ~* ${NON_HTML_PATH} and ${nonHtmlSpent("k")}`);
    await tx.execute(sql`update crawl_urls set state = 'budget_exhausted',
        reason = ${`The crawl's URL budget${budget !== null ? ` of ${budget}` : ""} was used up before this URL was fetched.`},
        lease_owner = null, lease_until = null, updated_at = now()
      where crawl_id = ${crawlId}::uuid and state in ('discovered', 'queued')`);
    await recomputeClickDepths(tx, crawlId, maxDepth);
  });
}

/**
 * Final click depth: one breadth-first pass over the recorded edges from the seeds. Only `<a>`/`<area>` links
 * (via 'link') count as a click; a redirect hop costs nothing; canonical, hreflang, alternate, pagination `<link>`
 * and iframe references are not clicks. A URL no link path reaches gets null ("not linked from the start URL"),
 * including sitemap-only pages. Replaces the frontier depth, which treats a sitemap-only page as depth 0.
 * `depth_exceeded` reasons are rewritten from the final depth, which is never lower than the frontier depth.
 */
export async function recomputeClickDepths(tx: Exec, crawlId: string, maxDepth: number | null): Promise<void> {
  await tx.execute(sql`create temp table if not exists click_depth (url text primary key, depth int not null) on commit drop`);
  await tx.execute(sql`truncate click_depth`);
  await tx.execute(sql`insert into click_depth select normalised_url, 0 from crawl_urls where crawl_id = ${crawlId}::uuid and 'seed' = any(discovered_via)`);
  const step = (via: "redirect" | "link", to: number, from: number) =>
    tx.execute(sql`insert into click_depth
      select distinct e.to_url, ${to}::int from url_edges e join click_depth b on b.url = e.from_url and b.depth = ${from}::int
      where e.crawl_id = ${crawlId}::uuid and e.via = ${via}
      on conflict do nothing`);
  for (let d = 0; ; d++) {
    // Redirect targets share the depth of their source, through any number of hops.
    for (let more = true; more; ) more = !!(await step("redirect", d, d)).rowCount;
    if (!(await step("link", d + 1, d)).rowCount) break;
  }
  await tx.execute(sql`update crawl_urls u set depth = b.depth, updated_at = now()
    from (select c.id, d.depth from crawl_urls c left join click_depth d on d.url = c.normalised_url where c.crawl_id = ${crawlId}::uuid) b
    where u.id = b.id and u.depth is distinct from b.depth`);
  if (maxDepth !== null) {
    await tx.execute(sql`update crawl_urls set reason = case when depth is null
        then 'Not reachable by links from the start URL, and found only through references beyond this crawl''s depth limit of ' || ${maxDepth}::int || '.'
        else 'Found only through links ' || depth || ' clicks from the start URL; this crawl follows links up to ' || ${maxDepth}::int || '.' end
      where crawl_id = ${crawlId}::uuid and state = 'depth_exceeded'`);
  }
}

/** "CDN-managed links: N": cdn_managed URLs, and the links to them and the pages they sit on (url_edges via link). */
export async function cdnManagedLinks(db: Exec, crawlId: string): Promise<{ urls: number; links: number; pages: number }> {
  const r = await db.execute(sql`select (select count(*)::int from crawl_urls where crawl_id = ${crawlId}::uuid and state = 'cdn_managed') as urls,
      count(e.*)::int as links, count(distinct e.from_url)::int as pages
    from url_edges e join crawl_urls c on c.crawl_id = e.crawl_id and c.normalised_url = e.to_url
    where e.crawl_id = ${crawlId}::uuid and e.via = 'link' and c.state = 'cdn_managed'`);
  return rows<{ urls: number; links: number; pages: number }>(r)[0];
}

export async function stateCounts(db: Exec, crawlId: string): Promise<Partial<Record<UrlState, number>>> {
  const r = await db.execute(sql`select state, count(*)::int as n from crawl_urls where crawl_id = ${crawlId}::uuid group by state`);
  return Object.fromEntries(rows<{ state: UrlState; n: number }>(r).map((x) => [x.state, x.n]));
}
