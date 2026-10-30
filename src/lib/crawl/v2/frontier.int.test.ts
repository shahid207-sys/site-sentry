import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import {
  activeCount,
  ClaimLostError,
  commitToSend,
  finalizeUrls,
  insertEdges,
  recordResult,
  releaseReservations,
  renewLeases,
  reserve,
  stateCounts,
  sweep,
  upsertUrls,
  type NewUrl,
} from "./frontier";

const db = testDb();
afterAll(() => db.$client.end());

const u = (path: string, via: NewUrl["via"], depth: number | null, extra: Partial<NewUrl> = {}): NewUrl => ({
  url: `https://example.test${path}`,
  original: `https://example.test${path}`,
  via,
  depth,
  ...extra,
});

async function row(crawlId: string, path: string) {
  const r = await db.execute(sql`select state, reason, depth, discovered_via, attempts from crawl_urls where crawl_id = ${crawlId}::uuid and normalised_url = ${`https://example.test${path}`}`);
  return r.rows[0] as { state: string; reason: string | null; depth: number | null; discovered_via: string[]; attempts: number } | undefined;
}

describe("upsertUrls", () => {
  it("merges discovery sources and keeps the smallest depth", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/a", "sitemap", null)]);
    await upsertUrls(db, c, [u("/a", "link", 4), u("/a", "canonical", 2)]);
    await upsertUrls(db, c, [u("/a", "link", 7)]);
    expect(await row(c, "/a")).toMatchObject({ state: "discovered", depth: 2, discovered_via: ["canonical", "link", "sitemap"] });
  });

  it("stores URLs that are terminal on arrival with their reason, and does not revive them", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/x", "link", 1, { state: "blocked_robots", reason: "Disallow: /x" })]);
    await upsertUrls(db, c, [u("/x", "sitemap", null)]);
    expect(await row(c, "/x")).toMatchObject({ state: "blocked_robots", reason: "Disallow: /x", discovered_via: ["link", "sitemap"] });
  });

  it("enforces the state and reason constraints in the database", async () => {
    const c = await newCrawl(db);
    await expect(db.execute(sql`insert into crawl_urls (crawl_id, url, normalised_url, state, discovered_via) values (${c}::uuid, 'u', 'u', 'fetched', '{link}')`)).rejects.toMatchObject({ cause: { constraint: "crawl_urls_reason_ck" } });
    await expect(db.execute(sql`insert into crawl_urls (crawl_id, url, normalised_url, state, discovered_via) values (${c}::uuid, 'v', 'v', 'bogus', '{link}')`)).rejects.toMatchObject({ cause: { constraint: "crawl_urls_state_ck" } });
  });
});

describe("reserve", () => {
  it("is breadth-first, puts sitemap-only URLs last, and respects the depth limit except for seeds and sitemaps", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, [
      u("/sitemap-only", "sitemap", null),
      u("/d2", "link", 2),
      u("/d0", "seed", 0),
      u("/d1", "link", 1),
      u("/too-deep", "link", 4),
      u("/too-deep-but-in-sitemap", "link", 4),
    ]);
    await upsertUrls(db, c, [u("/too-deep-but-in-sitemap", "sitemap", null)]);
    const path = (rs: { url: string }[]) => rs.map((r) => r.url.replace("https://example.test", ""));
    const got = await reserve(db, c, "w1", 10, 3);
    // Sitemap-only rows are held back while a row with a link depth can still be claimed (the batch has room for them).
    expect(path(got)).toEqual(["/d0", "/d1", "/d2", "/too-deep-but-in-sitemap"]);
    for (const r of got) await db.execute(sql`update crawl_urls set state = 'fetched', reason = 'test', lease_owner = null where id = ${r.id}`);
    // A row beyond the depth limit that nothing will claim does not hold them back.
    expect(path(await reserve(db, c, "w1", 10, 3))).toEqual(["/sitemap-only"]);
    expect((await row(c, "/too-deep"))!.state).toBe("discovered");
  });

  it("does not fetch sitemap-only pages before the link depths they would distort are known", async () => {
    // /home links to /a (depth 1), /a links to /b (depth 2). /b is also in the sitemap. If /b were fetched as
    // sitemap-only, its children would get depth 1 and /c's true depth (3) would be lost.
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/home", "seed", 0), u("/a", "sitemap", null), u("/b", "sitemap", null), u("/c", "sitemap", null)]);
    const first = await reserve(db, c, "w1", 200, null);
    expect(first.map((r) => r.url)).toEqual(["https://example.test/home"]);
  });

  it("gives concurrent workers disjoint rows (FOR UPDATE SKIP LOCKED)", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, Array.from({ length: 300 }, (_, i) => u(`/p${i}`, "link", 1)));
    const batches = await Promise.all(["a", "b", "c", "d"].map((w) => reserve(db, c, w, 100, null)));
    const ids = batches.flat().map((r) => r.id);
    expect(ids).toHaveLength(300);
    expect(new Set(ids).size).toBe(300);
  });
});

describe("at-most-once fetch accounting", () => {
  it("commits each URL exactly once across 8 concurrent workers", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, Array.from({ length: 600 }, (_, i) => u(`/q${i}`, "link", 1)));
    const sent: number[] = [];
    const worker = async (name: string) => {
      for (;;) {
        const batch = await reserve(db, c, name, 25, null);
        if (!batch.length) return;
        for (const r of batch) {
          const commit = await commitToSend(db, c, r.id, name);
          if (!commit.ok) continue;
          sent.push(r.id); // stands in for the HTTP request
          await recordResult(db, c, r.id, commit.token, { state: "fetched", reason: "HTTP 200", statusCode: 200 });
        }
      }
    };
    await Promise.all(Array.from({ length: 8 }, (_, i) => worker(`w${i}`)));
    expect(sent).toHaveLength(600);
    expect(new Set(sent).size).toBe(600);
    expect(await stateCounts(db, c)).toEqual({ fetched: 600 });
    const attempts = await db.execute(sql`select max(attempts)::int as m from crawl_urls where crawl_id = ${c}::uuid`);
    expect((attempts.rows[0] as { m: number }).m).toBe(1);
  });

  it("refuses a second commit for a URL already in fetching", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/once", "seed", 0)]);
    const [r] = await reserve(db, c, "w", 1, null);
    expect((await commitToSend(db, c, r.id, "w")).ok).toBe(true);
    expect(await commitToSend(db, c, r.id, "w")).toEqual({ ok: false, why: "lost" });
    expect(await commitToSend(db, c, r.id, "other")).toEqual({ ok: false, why: "lost" });
  });

  it("refuses to commit while the crawl is paused or cancelling, and hands the row back", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/s1", "link", 1)]);
    const [r] = await reserve(db, c, "w", 1, null);
    await db.execute(sql`update crawls set status = 'paused' where id = ${c}::uuid`);
    expect(await commitToSend(db, c, r.id, "w")).toEqual({ ok: false, why: "stopped" });
    expect(await activeCount(db, c)).toEqual({ discovered: 1, queued: 0, fetching: 0 });
  });

  it("charges the budget at commit time and stops at the budget", async () => {
    const c = await newCrawl(db, { budget: 5 });
    await upsertUrls(db, c, Array.from({ length: 12 }, (_, i) => u(`/b${i}`, "link", 1)));
    const batch = await reserve(db, c, "w", 12, null);
    expect(batch).toHaveLength(5);
    // The budget shrinks after the reservation (another path spent it): commit is the check that holds.
    await db.execute(sql`update crawls set budget = 3 where id = ${c}::uuid`);
    const outcomes = [];
    for (const r of batch) outcomes.push(await commitToSend(db, c, r.id, "w"));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(3);
    expect(outcomes.filter((o) => !o.ok && o.why === "budget")).toHaveLength(2);
    expect(await activeCount(db, c)).toEqual({ discovered: 9, queued: 0, fetching: 3 });
  });

  it("reserves no more than the budget left, breadth-first, so commit order cannot change which URLs are fetched", async () => {
    // Own lease owners: other tests release every reservation of "w".
    const c = await newCrawl(db, { budget: 3 });
    await upsertUrls(db, c, Array.from({ length: 10 }, (_, i) => u(`/s${i}`, "link", 1)));
    const first = await reserve(db, c, "cap", 8, null);
    expect(first.map((r) => r.url)).toEqual(["https://example.test/s0", "https://example.test/s1", "https://example.test/s2"]);
    // Committed in reverse: still exactly the reserved three.
    for (const r of [...first].reverse()) expect((await commitToSend(db, c, r.id, "cap")).ok).toBe(true);
    expect(await reserve(db, c, "cap", 8, null)).toEqual([]);

    // URLs reserved but not yet committed count against what is left.
    const d = await newCrawl(db, { budget: 3 });
    await upsertUrls(db, d, Array.from({ length: 6 }, (_, i) => u(`/q${i}`, "link", 1)));
    expect(await reserve(db, d, "cap", 2, null)).toHaveLength(2);
    expect((await reserve(db, d, "cap2", 8, null)).map((r) => r.url)).toEqual(["https://example.test/q2"]);
    // A reservation whose lease expired (its worker died) no longer holds a slot.
    await db.execute(sql`update crawl_urls set lease_until = now() - interval '1 second' where crawl_id = ${d}::uuid and lease_owner = 'cap'`);
    expect((await reserve(db, d, "cap2", 8, null)).map((r) => r.url)).toEqual(["https://example.test/q3", "https://example.test/q4"]);
    await releaseReservations(db, "cap");
    await releaseReservations(db, "cap2");
  });

  it("stops handing out URLs once the budget is spent, so a reserve/commit loop terminates", async () => {
    const c = await newCrawl(db, { budget: 5 });
    await upsertUrls(db, c, Array.from({ length: 12 }, (_, i) => u(`/l${i}`, "link", 1)));
    let sent = 0;
    for (let rounds = 0; rounds < 50; rounds++) {
      const batch = await reserve(db, c, "w", 4, null);
      if (!batch.length) break;
      for (const r of batch) {
        const commit = await commitToSend(db, c, r.id, "w");
        if (!commit.ok) continue;
        sent++;
        await recordResult(db, c, r.id, commit.token, { state: "fetched", reason: "HTTP 200", statusCode: 200 });
      }
    }
    expect(sent).toBe(5);
    expect(await reserve(db, c, "w", 4, null)).toEqual([]);
    expect(await activeCount(db, c)).toEqual({ discovered: 7, queued: 0, fetching: 0 });
  });

  it("discards a result whose claim token no longer matches, writing nothing", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/stale", "seed", 0)]);
    const [r] = await reserve(db, c, "w", 1, null);
    const commit = await commitToSend(db, c, r.id, "w");
    if (!commit.ok) throw new Error("commit failed");
    const attempt = recordResult(db, c, r.id, "not-the-token", {
      state: "fetched",
      reason: "HTTP 200",
      snapshot: { requestedUrl: "x", finalUrl: "x", statusCode: 200, contentType: "text/html", headers: {}, bytes: 1, truncated: false, elapsedMs: 1, contentHash: null, outlinkCount: 1, rawHtmlKey: null, blobStatus: null, extracted: null, extractMs: 0 },
      newUrls: [u("/child", "link", 1)],
      edges: [{ fromUrl: r.url, toUrl: "https://example.test/child", via: "link", anchor: null, rel: null, location: "main", nofollow: false }],
    });
    await expect(attempt).rejects.toBeInstanceOf(ClaimLostError);
    expect(await row(c, "/child")).toBeUndefined();
    const snaps = await db.execute(sql`select count(*)::int as n from page_snapshots where crawl_id = ${c}::uuid`);
    const edges = await db.execute(sql`select count(*)::int as n from url_edges where crawl_id = ${c}::uuid`);
    expect([(snaps.rows[0] as { n: number }).n, (edges.rows[0] as { n: number }).n]).toEqual([0, 0]);
  });
});

describe("recovery and finalisation", () => {
  it("sweep returns expired reservations to the frontier and marks expired in-flight requests interrupted", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/r1", "link", 1), u("/r2", "link", 1)]);
    const batch = await reserve(db, c, "dead", 2, null, 1);
    await commitToSend(db, c, batch[0].id, "dead", 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await sweep(db, c)).toEqual({ requeued: 1, interrupted: 1 });
    const inflight = await row(c, batch[0].url.replace("https://example.test", ""));
    expect(inflight).toMatchObject({ state: "interrupted" });
    expect(inflight!.reason).toMatch(/not re-requested/);
    // The interrupted URL is never handed out again.
    const again = await reserve(db, c, "new", 10, null);
    expect(again.map((r) => r.id)).toEqual([batch[1].id]);
  });

  it("a forced sweep recovers a crawl immediately, without waiting for leases to expire", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/k1", "link", 1), u("/k2", "link", 1)]);
    const batch = await reserve(db, c, "killed", 2, null);
    await commitToSend(db, c, batch[0].id, "killed");
    expect(await sweep(db, c)).toEqual({ requeued: 0, interrupted: 0 });
    expect(await sweep(db, c, { force: true })).toEqual({ requeued: 1, interrupted: 1 });
  });

  it("releaseReservations hands unsent rows back on pause", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/p1", "link", 1), u("/p2", "link", 1)]);
    await reserve(db, c, "w", 2, null);
    expect(await releaseReservations(db, "w")).toBe(2);
    expect(await activeCount(db, c)).toEqual({ discovered: 2, queued: 0, fetching: 0 });
  });

  it("finalize gives every leftover URL a terminal state with a reason", async () => {
    const c = await newCrawl(db, { budget: 1, maxDepth: 2 });
    await upsertUrls(db, c, [u("/f0", "seed", 0), u("/f1", "link", 1), u("/deep", "link", 5)]);
    const [first] = await reserve(db, c, "w", 1, 2);
    const commit = await commitToSend(db, c, first.id, "w");
    if (!commit.ok) throw new Error("commit failed");
    await recordResult(db, c, first.id, commit.token, { state: "fetched", reason: "HTTP 200", statusCode: 200 });
    await finalizeUrls(db, c, "completed", 2, 1);
    expect(await stateCounts(db, c)).toEqual({ fetched: 1, budget_exhausted: 1, depth_exceeded: 1 });
    // No recorded edge reaches /deep, so its final click depth is unknown and the reason says so.
    expect(await row(c, "/deep")).toMatchObject({ depth: null, reason: expect.stringMatching(/^Not reachable by links from the start URL/) });
    expect(await activeCount(db, c)).toEqual({ discovered: 0, queued: 0, fetching: 0 });
  });

  it("finalize recomputes click depth by one BFS over link edges from the seeds", async () => {
    const c = await newCrawl(db, { maxDepth: 3 });
    // Frontier depths as a crawl leaves them: /s is sitemap-only, so /x got depth 1 from it although links reach /x
    // only at depth 3; /orphan-child is linked only from /s; /canon is reached only by a canonical reference.
    await upsertUrls(db, c, [
      u("/", "seed", 0), u("/a", "link", 1), u("/b", "link", 2), u("/x", "link", 1), u("/s", "sitemap", null),
      u("/orphan-child", "link", 1), u("/old", "link", 1), u("/mid", "redirect", 1), u("/new", "redirect", 1),
      u("/canon", "canonical", 1), u("/c4", "link", 4),
    ]);
    const e = (from: string, to: string, via = "link") => ({ fromUrl: `https://example.test${from}`, toUrl: `https://example.test${to}`, via, anchor: null, rel: null, location: null, nofollow: false });
    await insertEdges(db, c, [
      e("/", "/a"), e("/a", "/b"), e("/b", "/x"), e("/s", "/x"), e("/s", "/orphan-child"),
      e("/", "/old"), e("/old", "/mid", "redirect"), e("/mid", "/new", "redirect"), e("/new", "/a"),
      e("/a", "/canon", "canonical"), e("/x", "/c4"),
      e("/b", "/a"), // a cycle back up does not lower or loop
    ]);
    await db.execute(sql`update crawl_urls set state = 'fetched', reason = 'HTTP 200' where crawl_id = ${c}::uuid and normalised_url !~ '/c4$'`);
    await finalizeUrls(db, c, "completed", 3, null);

    const depths: Record<string, number | null> = {};
    for (const p of ["/", "/a", "/b", "/x", "/s", "/orphan-child", "/old", "/mid", "/new", "/canon", "/c4"]) depths[p] = (await row(c, p))!.depth;
    expect(depths).toEqual({ "/": 0, "/a": 1, "/b": 2, "/x": 3, "/s": null, "/orphan-child": null, "/old": 1, "/mid": 1, "/new": 1, "/canon": null, "/c4": 4 });
    // The depth_exceeded reason quotes the final depth, not the frontier's.
    expect(await row(c, "/c4")).toMatchObject({ state: "depth_exceeded", reason: "Found only through links 4 clicks from the start URL; this crawl follows links up to 3." });
  });

  it("finalize on cancel marks leftovers cancelled", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/c1", "link", 1), u("/c2", "link", 1)]);
    await reserve(db, c, "w", 1, null);
    await finalizeUrls(db, c, "cancelled", null, null);
    expect(await stateCounts(db, c)).toEqual({ cancelled: 2 });
  });
});

describe("recordResult under concurrency", () => {
  it("does not deadlock when pages that link to each other are recorded at the same time", async () => {
    const c = await newCrawl(db);
    const N = 30;
    const paths = Array.from({ length: N }, (_, i) => `/nav/${i}`);
    await upsertUrls(db, c, paths.map((p) => u(p, "seed", 0)));
    const batch = await reserve(db, c, "w", N, null);
    const tokens = new Map<number, string>();
    for (const r of batch) {
      const k = await commitToSend(db, c, r.id, "w");
      if (!k.ok) throw new Error("commit failed");
      tokens.set(r.id, k.token);
    }
    // Every page links to every other page, as a site-wide navigation does; all results are written at once.
    await Promise.all(
      batch.map((r) =>
        recordResult(db, c, r.id, tokens.get(r.id)!, {
          state: "fetched",
          reason: "HTTP 200",
          newUrls: paths.map((p) => u(p, "link", 1)),
          edges: paths.map((p) => ({ fromUrl: r.url, toUrl: `https://example.test${p}`, via: "link" as const, anchor: null, rel: null, location: "nav", nofollow: false })),
        }),
      ),
    );
    expect(await stateCounts(db, c)).toEqual({ fetched: N });
  });

  it("runs the write again when Postgres aborts it to break a deadlock with a URL inserted after the pre-lock", async () => {
    // The validation crawl on a live site died on 40P01: a linked URL that another transaction inserted (uncommitted)
    // after this one's pre-lock is locked late, out of order. Reproduced exactly: X inserts /late, then this write
    // waits on X for /late while X waits on this write's own row.
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/page", "seed", 0)]);
    const [r] = await reserve(db, c, "w", 1, null);
    const k = await commitToSend(db, c, r.id, "w");
    if (!k.ok) throw new Error("commit failed");
    const x = await db.$client.connect();
    try {
      // X never runs the deadlock check itself, so Postgres always aborts the write, the side under test.
      await x.query("begin; set local deadlock_timeout = '60s'");
      await x.query("insert into crawl_urls (crawl_id, url, normalised_url, state, discovered_via) values ($1, $2, $2, 'discovered', '{sitemap}')", [c, "https://example.test/late"]);
      const write = recordResult(db, c, r.id, k.token, { state: "fetched", reason: "HTTP 200", statusCode: 200, newUrls: [u("/late", "link", 1)] });
      // Wait until the write is blocked on X's uncommitted /late row, then make X wait on the write's own row.
      for (let i = 0; i < 100; i++) {
        const w = await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'transactionid' and not granted`);
        if ((w.rows[0] as { n: number }).n > 0) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      await x.query("select id from crawl_urls where id = $1 for update", [r.id]);
      await x.query("commit");
      await write;
    } finally {
      x.release();
    }
    expect(await row(c, "/page")).toMatchObject({ state: "fetched", attempts: 1 });
    expect((await row(c, "/late"))?.discovered_via).toEqual(["link", "sitemap"]);
  });

  it("lease renewal skips a row another transaction holds instead of waiting on it (no lock cycle)", async () => {
    // Gate 2a died on 40P01: renewal (one update over all of a worker's rows, in heap order) waited on a row a
    // recordResult had pre-locked, while that write waited on a row the renewal already held.
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/a", "seed", 0), u("/b", "seed", 0)]);
    await reserve(db, c, "w", 2, null);
    await db.execute(sql`update crawl_urls set lease_until = now() - interval '1 minute' where crawl_id = ${c}::uuid`);
    const x = await db.$client.connect();
    try {
      await x.query("begin");
      await x.query("select id from crawl_urls where crawl_id = $1 and normalised_url = $2 for update", [c, "https://example.test/a"]);
      const t0 = Date.now();
      await Promise.race([renewLeases(db, "w", 60_000), new Promise((_, rej) => setTimeout(() => rej(new Error("renewLeases waited on a locked row")), 3000))]);
      expect(Date.now() - t0).toBeLessThan(3000);
    } finally {
      await x.query("rollback"); // never hand a connection with an open transaction back to the pool
      x.release();
    }
    const leases = await db.execute(sql`select normalised_url as url, lease_until > now() as live from crawl_urls where crawl_id = ${c}::uuid order by url`);
    expect(leases.rows).toEqual([
      { url: "https://example.test/a", live: false }, // skipped: locked; the next renewal covers it
      { url: "https://example.test/b", live: true },
    ]);
    await renewLeases(db, "w", 60_000);
    const after = await db.execute(sql`select bool_and(lease_until > now()) as live from crawl_urls where crawl_id = ${c}::uuid`);
    expect((after.rows[0] as { live: boolean }).live).toBe(true);
  });

  it("runs commitToSend again when Postgres aborts it to break a deadlock, charging the budget once", async () => {
    const c = await newCrawl(db);
    await upsertUrls(db, c, [u("/page", "seed", 0)]);
    const [r] = await reserve(db, c, "w", 1, null);
    const before = ((await db.execute(sql`select fetches_committed as n from crawls where id = ${c}::uuid`)).rows[0] as { n: number }).n;
    const x = await db.$client.connect();
    let k: Awaited<ReturnType<typeof commitToSend>>;
    try {
      // X holds the crawl row; the commit locks its URL row, then waits on X; X then waits on the URL row: a cycle.
      // X never runs the deadlock check itself, so Postgres aborts the commit, the side under test.
      await x.query("begin; set local deadlock_timeout = '60s'");
      await x.query("update crawls set heartbeat_at = now() where id = $1", [c]);
      const commit = commitToSend(db, c, r.id, "w");
      for (let i = 0; i < 100; i++) {
        const w = await db.execute(sql`select count(*)::int as n from pg_locks where locktype = 'transactionid' and not granted`);
        if ((w.rows[0] as { n: number }).n > 0) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      await x.query("select id from crawl_urls where id = $1 for update", [r.id]);
      await x.query("commit");
      k = await commit;
    } finally {
      x.release();
    }
    expect(k.ok).toBe(true);
    expect(await row(c, "/page")).toMatchObject({ state: "fetching", attempts: 1 });
    const n = ((await db.execute(sql`select fetches_committed as n from crawls where id = ${c}::uuid`)).rows[0] as { n: number }).n;
    expect(n).toBe(before + 1);
  });
});
