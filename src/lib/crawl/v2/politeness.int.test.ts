import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { HostThrottle, MAX_CRAWL_DELAY_MS, type ThrottleOptions } from "./politeness";

const url = process.env.REDIS_URL ?? "redis://127.0.0.1:6379";
const redis = new Redis(url);
const other = new Redis(url); // a second connection stands in for a second worker process
afterAll(async () => {
  await redis.quit();
  await other.quit();
});

/** A fake clock: sleep advances time instantly, so schedules can be asserted exactly. */
function clock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => (t += ms),
  };
}

/** A throttle on a host no other test uses. */
const prefix = () => `test:throttle:${randomUUID()}:`;
const throttle = (opts: ThrottleOptions = {}, conn = redis) => new HostThrottle(conn, "site.test", { keyPrefix: prefix(), ...opts });

describe("HostThrottle (Redis)", () => {
  it("caps requests in flight at the host concurrency (default 3)", async () => {
    const c = clock();
    const th = throttle({ now: c.now, sleep: c.sleep, ratePerSecond: 1000 });
    const slots = [];
    for (let i = 0; i < 3; i++) slots.push(await th.acquire());
    let fourth = false;
    const p = th.acquire().then(() => (fourth = true));
    await new Promise((r) => setTimeout(r, 120)); // longer than the cross-process poll
    expect(fourth).toBe(false);
    expect(await th.snapshot()).toMatchObject({ inFlight: 3, limit: 3 });
    await th.release(slots[0], { status: 200, elapsedMs: 10 });
    await p;
    expect(fourth).toBe(true);
  });

  it("shares one budget across connections: a second worker cannot add a 4th request to the host", async () => {
    const keyPrefix = prefix();
    const a = new HostThrottle(redis, "shared.test", { keyPrefix, ratePerSecond: 1000 });
    const b = new HostThrottle(other, "shared.test", { keyPrefix, ratePerSecond: 1000 });
    const held = [await a.acquire(), await a.acquire(), await b.acquire()];
    let fourth = false;
    const p = b.acquire().then((s) => ((fourth = true), s));
    await new Promise((r) => setTimeout(r, 150));
    expect(fourth).toBe(false);
    await a.release(held[0], { status: 200, elapsedMs: 5 }); // freed in "worker A"; "worker B" sees it by polling
    const s = await p;
    expect(fourth).toBe(true);
    expect((await b.snapshot()).inFlight).toBe(3);
    for (const x of [held[1], held[2], s]) await a.release(x);
  });

  it("frees a slot whose holder died once its lease expires", async () => {
    const c = clock();
    const th = throttle({ now: c.now, sleep: c.sleep, ratePerSecond: 1000, maxConcurrency: 1, leaseMs: 5_000 });
    await th.acquire(); // never released: the worker was killed
    expect((await th.snapshot()).inFlight).toBe(1);
    c.advance(5_001);
    expect((await th.snapshot()).inFlight).toBe(0);
    await th.acquire();
  });

  it("spaces request starts by the rate cap (5/s → 200 ms)", async () => {
    const c = clock();
    const th = throttle({ now: c.now, sleep: c.sleep });
    const starts: number[] = [];
    for (let i = 0; i < 4; i++) {
      const s = await th.acquire();
      starts.push(c.now());
      await th.release(s, { status: 200, elapsedMs: 5 });
    }
    expect(starts).toEqual([0, 200, 400, 600]);
  });

  it("honours Crawl-delay when it is slower than the rate cap, capped at 60 s, for every throttle on the host", async () => {
    const c = clock();
    const keyPrefix = prefix();
    const th = new HostThrottle(redis, "delay.test", { keyPrefix, now: c.now, sleep: c.sleep });
    await th.setCrawlDelay(2000);
    expect(th.intervalMs).toBe(2000);
    await th.release(await th.acquire(), { status: 200 });
    // A throttle that never read robots.txt (another worker) still waits out the host's Crawl-delay.
    const peer = new HostThrottle(other, "delay.test", { keyPrefix, now: c.now, sleep: c.sleep });
    await peer.acquire();
    expect(c.now()).toBe(2000);
    const capped = throttle();
    await capped.setCrawlDelay(3_600_000);
    expect(capped.intervalMs).toBe(MAX_CRAWL_DELAY_MS);
  });

  it("halves concurrency and backs off exponentially on 429/503, or for exactly Retry-After when given", async () => {
    const c = clock();
    const th = throttle({ now: c.now, sleep: c.sleep, ratePerSecond: 1000, baseBackoffMs: 1000 });
    await th.release(await th.acquire(), { status: 429, elapsedMs: 10 });
    expect((await th.snapshot()).limit).toBe(1);
    expect(th.events.at(-1)).toMatchObject({ reason: "429", pausedForMs: 1000 });

    let s = await th.acquire();
    expect(c.now()).toBe(1000);
    await th.release(s, { status: 503, elapsedMs: 10, retryAfterMs: 5000 });
    expect(th.events.at(-1)).toMatchObject({ reason: "503", concurrency: 1, pausedForMs: 5000 });
    s = await th.acquire();
    expect(c.now()).toBe(6000);
    await th.release(s, { status: 503, elapsedMs: 10 });
    expect(th.events.at(-1)).toMatchObject({ pausedForMs: 2000 }); // 1 s → (Retry-After 5 s) → 2 s
    await th.release(await th.acquire(), { status: 429, elapsedMs: 10, retryAfterMs: 0 });
    expect(th.events.at(-1)).toMatchObject({ pausedForMs: 1000 }); // Retry-After: 0 still waits the 1 s base
  });

  it("halves the backoff on each normal response", async () => {
    const c = clock();
    const th = throttle({ now: c.now, sleep: c.sleep, ratePerSecond: 1000, baseBackoffMs: 1000 });
    const respond = async (status: number) => th.release(await th.acquire(), { status, elapsedMs: 10 });
    for (const status of [429, 429, 429]) await respond(status);
    expect(th.events.map((e) => e.pausedForMs)).toEqual([1000, 2000, 4000]);
    await respond(200); // 4 s → 2 s
    await respond(429);
    expect(th.events.at(-1)).toMatchObject({ pausedForMs: 4000 }); // 2 s doubled, not 8 s
    for (let i = 0; i < 3; i++) await respond(200); // 4 → 2 → 1 → 0
    await respond(503);
    expect(th.events.at(-1)).toMatchObject({ pausedForMs: 1000 }); // back to the base
  });

  it("caps a host pause at maxBackoffMs, however long Retry-After asks for", async () => {
    const c = clock();
    const th = throttle({ now: c.now, sleep: c.sleep, ratePerSecond: 1000, maxBackoffMs: 60_000 });
    await th.release(await th.acquire(), { status: 503, retryAfterMs: 3_600_000 });
    expect(th.events.at(-1)).toMatchObject({ pausedForMs: 60_000 });
    await th.acquire();
    expect(c.now()).toBe(60_000);
  });

  it("slows down when p95 latency over the window exceeds 3 s, then recovers additively", async () => {
    const c = clock();
    const th = throttle({ now: c.now, sleep: c.sleep, ratePerSecond: 1000 }); // window 20
    const respond = async (elapsedMs: number) => th.release(await th.acquire(), { status: 200, elapsedMs });
    const limit = async () => (await th.snapshot()).limit;
    for (let i = 0; i < 20; i++) await respond(100);
    expect(await limit()).toBe(3); // already at max
    await respond(4000); // one outlier in 20: p95 is still 100 ms
    expect(th.events).toEqual([]);
    await respond(4000); // two in 20: p95 is 4 s
    expect(th.events).toMatchObject([{ reason: "slow_p95", concurrency: 1 }]);
    expect(await limit()).toBe(1);
    for (let i = 0; i < 19; i++) await respond(100);
    expect(await limit()).toBe(1);
    await respond(100); // a full window of normal responses: +1
    expect(await limit()).toBe(2);
    for (let i = 0; i < 10; i++) await respond(100);
    await respond(5000); // a slow response restarts the recovery count
    for (let i = 0; i < 19; i++) await respond(100);
    expect(await limit()).toBe(2);
  });

  it("does not adapt when no request was sent", async () => {
    const th = throttle();
    await th.release(await th.acquire());
    expect(await th.snapshot()).toMatchObject({ inFlight: 0, limit: 3 });
    expect(th.events).toEqual([]);
  });

  it("uses Redis's clock when no clock is given", async () => {
    const th = throttle({ ratePerSecond: 2 }); // 500 ms apart
    await th.release(await th.acquire());
    const t0 = Date.now();
    await th.acquire();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(400);
  });

  it("stops waiting when the signal aborts, and holds no slot afterwards", async () => {
    const th = throttle({ ratePerSecond: 1000 });
    for (let i = 0; i < 3; i++) await th.acquire();
    const ac = new AbortController();
    const p = th.acquire(ac.signal);
    ac.abort(new Error("shutdown"));
    await expect(p).rejects.toThrow("shutdown");
    await new Promise((r) => setTimeout(r, 50));
    expect((await th.snapshot()).inFlight).toBe(3);
  });
});
