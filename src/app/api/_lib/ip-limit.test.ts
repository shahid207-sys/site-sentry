import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp } from "./handler";
import { createLimiterRedis, limitByIp } from "./ip-limit";

const req = (headers: Record<string, string>) => new NextRequest("http://localhost/api/live/audits/quick", { method: "POST", headers });
const xff = (ip: string) => req({ "x-forwarded-for": ip });

afterEach(() => vi.unstubAllEnvs());

/** A Redis client that cannot connect, so limitByIp runs its in-process fallback (no Redis needed for unit tests). */
function deadRedis() {
  const redis = createLimiterRedis("redis://127.0.0.1:1"); // nothing listens on port 1
  redis.on("error", () => {});
  return redis;
}
const newLimit = () => ({ key: `rl:test:${randomUUID()}`, limit: 5, windowMs: 60_000, message: (s: number) => `wait ${s}s` });

describe("clientIp", () => {
  it("ignores every forwarding header when TRUSTED_PROXY_HEADER is not set", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    expect(clientIp(req({ "x-forwarded-for": "203.0.113.9", "x-real-ip": "203.0.113.9", "cf-connecting-ip": "203.0.113.9" }))).toBeNull();
  });

  it("reads only the configured header, and takes the rightmost X-Forwarded-For entry (the one the proxy appended)", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "X-Forwarded-For");
    expect(clientIp(xff("1.1.1.1, 203.0.113.9"))).toBe("203.0.113.9"); // 1.1.1.1 was sent by the client
    expect(clientIp(req({ "x-real-ip": "203.0.113.9" }))).toBeNull();
    vi.stubEnv("TRUSTED_PROXY_HEADER", "cf-connecting-ip");
    expect(clientIp(req({ "cf-connecting-ip": "2001:db8::1", "x-forwarded-for": "203.0.113.9" }))).toBe("2001:db8::1");
  });

  it("rejects a value that is not an IP address", () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-forwarded-for");
    expect(clientIp(xff("not-an-ip"))).toBeNull();
    expect(clientIp(xff(""))).toBeNull();
  });
});

describe("limitByIp", () => {
  it("refuses with 503 in production when no proxy header is configured", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    await expect(limitByIp(xff("203.0.113.9"), newLimit(), { redis: deadRedis() })).rejects.toMatchObject({
      status: 503,
      code: "PROXY_NOT_CONFIGURED",
      message: "The client address is unavailable: proxy header not configured (set TRUSTED_PROXY_HEADER).",
    });
  });

  it("refuses with 503 in production when the configured header is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "cf-connecting-ip");
    await expect(limitByIp(xff("203.0.113.9"), newLimit(), { redis: deadRedis() })).rejects.toMatchObject({ status: 503, code: "PROXY_NOT_CONFIGURED" });
  });

  it("outside production without a proxy header, puts every client in one bucket: a spoofed X-Forwarded-For does not get a fresh one", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    const redis = deadRedis();
    const limit = newLimit();
    try {
      for (let i = 1; i <= 5; i++) await limitByIp(xff(`192.0.2.${i}`), limit, { redis, log: () => {} });
      await expect(limitByIp(xff("192.0.2.99"), limit, { redis, log: () => {} })).rejects.toMatchObject({ status: 429 });
    } finally {
      redis.disconnect();
    }
  });

  it("without Redis, falls back to the in-process limiter within a second, logs it, and still enforces the limit", async () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "x-forwarded-for");
    const redis = deadRedis();
    const logs: string[] = [];
    const limit = newLimit();
    const ip = "192.0.2.10";
    try {
      const t0 = Date.now();
      await limitByIp(xff(ip), limit, { redis, log: (m) => logs.push(m) });
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(logs[0]).toMatch(new RegExp(`^\\[site-sentry\\] rate limit ${limit.key}: Redis unreachable \\(.+\\); using this process's in-memory limiter\\.$`));
      for (let i = 2; i <= 5; i++) await limitByIp(xff(ip), limit, { redis, log: (m) => logs.push(m) });
      await expect(limitByIp(xff(ip), limit, { redis, log: (m) => logs.push(m) })).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/^wait \d+s$/) });
      await limitByIp(xff("192.0.2.11"), limit, { redis, log: (m) => logs.push(m) }); // other IPs are unaffected
      await expect(limitByIp(xff(`192.0.2.11, ${ip}`), limit, { redis, log: (m) => logs.push(m) })).rejects.toMatchObject({ status: 429 }); // a prepended address changes nothing
      expect(logs).toHaveLength(8);
    } finally {
      redis.disconnect();
    }
  });
});
