import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLimiterRedis, slidingWindow } from "./ip-limit";

const redis = createLimiterRedis();
beforeAll(() => redis.connect()); // lazyConnect: limitByIp connects on first use
afterAll(() => redis.quit());

describe("slidingWindow (Redis)", () => {
  it("allows 5 per window, denies the 6th without counting it, and allows again once the oldest slides out", async () => {
    const key = `rl:test:${randomUUID()}`;
    const hour = 3_600_000;
    const t0 = 1_000_000_000_000;
    for (let i = 0; i < 5; i++) expect(await slidingWindow(redis, key, 5, hour, t0 + i * 1_000)).toMatchObject({ allowed: true, count: i + 1 });

    const denied = await slidingWindow(redis, key, 5, hour, t0 + 10_000);
    expect(denied).toEqual({ allowed: false, count: 5, retryAfterMs: hour - 10_000 });
    expect(await redis.zcard(key)).toBe(5); // the denied attempt left no member behind
    expect(await slidingWindow(redis, key, 5, hour, t0 + 20_000)).toMatchObject({ allowed: false });

    // One hour after the first request, it leaves the window and exactly one slot opens.
    expect(await slidingWindow(redis, key, 5, hour, t0 + hour + 1)).toMatchObject({ allowed: true, count: 5 });
    expect(await slidingWindow(redis, key, 5, hour, t0 + hour + 2)).toMatchObject({ allowed: false });
    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(hour);
  });

  it("counts two requests in the same millisecond separately", async () => {
    const key = `rl:test:${randomUUID()}`;
    const now = Date.now();
    await Promise.all([slidingWindow(redis, key, 5, 60_000, now), slidingWindow(redis, key, 5, 60_000, now)]);
    expect(await redis.zcard(key)).toBe(2);
  });
});
