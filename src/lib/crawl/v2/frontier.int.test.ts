import { sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { newCrawl, testDb } from "@/test/db";
import {
  activeCount,
  ClaimLostError,
  commitToSend,
  finalizeUrls,
  recordResult,
  releaseReservations,
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
    const got = await reserve(db, c, "w1", 10, 3);
    expect(got.map((r) => r.url.replace("https://example.test", ""))).toEqual(["/d0", "/d1", "/d2", "/too-deep-but-in-sitemap", "/sitemap-only"]);
    expect((await row(c, "/too-deep"))!.state).toBe("discovered");
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
    const outcomes = [];
    for (const r of batch) outcomes.push(await commitToSend(db, c, r.id, "w"));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(5);
    expect(outcomes.filter((o) => !o.ok && o.why === "budget")).toHaveLength(7);
    expect(await activeCount(db, c)).toEqual({ discovered: 7, queued: 0, fetching: 5 });
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
      snapshot: { finalUrl: "x", statusCode: 200, contentType: "text/html", headers: {}, bytes: 1, truncated: false, elapsedMs: 1, contentHash: null, outlinkCount: 1 },
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
    expect((await row(c, "/deep"))!.reason).toMatch(/5 clicks/);
    expect(await activeCount(db, c)).toEqual({ discovered: 0, queued: 0, fetching: 0 });
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
});
