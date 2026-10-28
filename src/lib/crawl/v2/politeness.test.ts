import { describe, expect, it } from "vitest";
import { HostThrottle, MAX_CRAWL_DELAY_MS, p95, parseRetryAfter } from "./politeness";

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

describe("HostThrottle", () => {
  it("caps requests in flight at the host concurrency (default 3)", async () => {
    const c = clock();
    const th = new HostThrottle({ now: c.now, sleep: c.sleep, ratePerSecond: 1000 });
    for (let i = 0; i < 3; i++) await th.acquire();
    let fourth = false;
    const p = th.acquire().then(() => (fourth = true));
    await Promise.resolve();
    expect(fourth).toBe(false);
    expect(th.inFlight).toBe(3);
    th.release({ status: 200, elapsedMs: 10 });
    await p;
    expect(fourth).toBe(true);
  });

  it("spaces request starts by the rate cap (5/s → 200 ms)", async () => {
    const c = clock();
    const th = new HostThrottle({ now: c.now, sleep: c.sleep });
    const starts: number[] = [];
    for (let i = 0; i < 4; i++) {
      await th.acquire();
      starts.push(c.now());
      th.release({ status: 200, elapsedMs: 5 });
    }
    expect(starts).toEqual([0, 200, 400, 600]);
  });

  it("honours Crawl-delay when it is slower than the rate cap, capped at 60 s", async () => {
    const c = clock();
    const th = new HostThrottle({ now: c.now, sleep: c.sleep, crawlDelayMs: 2000 });
    expect(th.intervalMs).toBe(2000);
    await th.acquire();
    th.release({ status: 200 });
    await th.acquire();
    expect(c.now()).toBe(2000);
    expect(new HostThrottle({ crawlDelayMs: 3_600_000 }).intervalMs).toBe(MAX_CRAWL_DELAY_MS);
  });

  it("halves concurrency and backs off exponentially on 429/503, or for exactly Retry-After when given", async () => {
    const c = clock();
    const th = new HostThrottle({ now: c.now, sleep: c.sleep, ratePerSecond: 1000, baseBackoffMs: 1000 });
    await th.acquire();
    th.release({ status: 429, elapsedMs: 10 });
    expect(th.limit).toBe(1);
    expect(th.events.at(-1)).toMatchObject({ reason: "429", pausedForMs: 1000 });

    await th.acquire();
    expect(c.now()).toBe(1000);
    th.release({ status: 503, elapsedMs: 10, retryAfterMs: 5000 });
    expect(th.events.at(-1)).toMatchObject({ reason: "503", concurrency: 1, pausedForMs: 5000 });
    await th.acquire();
    expect(c.now()).toBe(6000);
    th.release({ status: 503, elapsedMs: 10 });
    expect(th.events.at(-1)).toMatchObject({ pausedForMs: 2000 }); // 1 s → (Retry-After 5 s) → 2 s
    await th.acquire();
    th.release({ status: 429, elapsedMs: 10, retryAfterMs: 0 });
    expect(th.events.at(-1)).toMatchObject({ pausedForMs: 1000 }); // Retry-After: 0 still waits the 1 s base
  });

  it("halves the backoff on each normal response", async () => {
    const c = clock();
    const th = new HostThrottle({ now: c.now, sleep: c.sleep, ratePerSecond: 1000, baseBackoffMs: 1000 });
    for (const status of [429, 429, 429]) {
      await th.acquire();
      th.release({ status, elapsedMs: 10 });
    }
    expect(th.events.map((e) => e.pausedForMs)).toEqual([1000, 2000, 4000]);
    await th.acquire();
    th.release({ status: 200, elapsedMs: 10 }); // 4 s → 2 s
    await th.acquire();
    th.release({ status: 429, elapsedMs: 10 });
    expect(th.events.at(-1)).toMatchObject({ pausedForMs: 4000 }); // 2 s doubled, not 8 s
    for (let i = 0; i < 3; i++) {
      await th.acquire();
      th.release({ status: 200, elapsedMs: 10 }); // 4 → 2 → 1 → 0
    }
    await th.acquire();
    th.release({ status: 503, elapsedMs: 10 });
    expect(th.events.at(-1)).toMatchObject({ pausedForMs: 1000 }); // back to the base
  });

  it("caps a host pause at maxBackoffMs, however long Retry-After asks for", async () => {
    const c = clock();
    const th = new HostThrottle({ now: c.now, sleep: c.sleep, ratePerSecond: 1000, maxBackoffMs: 60_000 });
    await th.acquire();
    th.release({ status: 503, retryAfterMs: 3_600_000 });
    expect(th.events.at(-1)).toMatchObject({ pausedForMs: 60_000 });
    await th.acquire();
    expect(c.now()).toBe(60_000);
  });

  it("slows down when p95 latency over the window exceeds 3 s, then recovers additively", async () => {
    const c = clock();
    const th = new HostThrottle({ now: c.now, sleep: c.sleep, ratePerSecond: 1000 }); // window 20
    const respond = async (elapsedMs: number) => {
      await th.acquire();
      th.release({ status: 200, elapsedMs });
    };
    for (let i = 0; i < 20; i++) await respond(100);
    expect(th.limit).toBe(3); // already at max
    await respond(4000); // one outlier in 20: p95 is still 100 ms
    expect(th.events).toEqual([]);
    await respond(4000); // two in 20: p95 is 4 s
    expect(th.events).toMatchObject([{ reason: "slow_p95", concurrency: 1 }]);
    expect(th.limit).toBe(1);
    for (let i = 0; i < 19; i++) await respond(100);
    expect(th.limit).toBe(1);
    await respond(100); // a full window of normal responses: +1
    expect(th.limit).toBe(2);
    for (let i = 0; i < 10; i++) await respond(100);
    await respond(5000); // a slow response restarts the recovery count
    for (let i = 0; i < 19; i++) await respond(100);
    expect(th.limit).toBe(2);
  });

  it("does not adapt when no request was sent", async () => {
    const th = new HostThrottle();
    await th.acquire();
    th.release();
    expect(th.limit).toBe(3);
    expect(th.events).toEqual([]);
  });

  it("stops waiting when the signal aborts", async () => {
    const th = new HostThrottle({ ratePerSecond: 1000 });
    for (let i = 0; i < 3; i++) await th.acquire();
    const ac = new AbortController();
    const p = th.acquire(ac.signal);
    ac.abort(new Error("shutdown"));
    await expect(p).rejects.toThrow("shutdown");
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds and HTTP dates", () => {
    expect(parseRetryAfter("120")).toBe(120_000);
    const now = Date.parse("2026-10-28T10:00:00Z");
    expect(parseRetryAfter("Wed, 28 Oct 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Wed, 28 Oct 2026 09:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter(null)).toBeNull();
  });
});

describe("p95", () => {
  it("is the 95th-percentile sample", () => {
    expect(p95(Array.from({ length: 20 }, (_, i) => i + 1))).toBe(19);
    expect(p95([])).toBe(0);
  });
});
