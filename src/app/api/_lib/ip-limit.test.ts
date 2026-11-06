import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clientIp } from "./handler";
import { createLimiterRedis, isLocalRequest, limitByIp, QUICK_AUDIT_UNAVAILABLE, resetIpLimitWarnings } from "./ip-limit";

// A public host by default, so the localhost exemption does not apply unless a test asks for it.
const req = (headers: Record<string, string>, origin = "https://audit.example.com") => new NextRequest(`${origin}/api/live/audits/quick`, { method: "POST", headers });
const xff = (ip: string) => req({ "x-forwarded-for": ip });
const local = (headers: Record<string, string> = {}, origin = "http://localhost:3000") => req(headers, origin);

afterEach(() => {
  vi.unstubAllEnvs();
  resetIpLimitWarnings();
});

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
  it("refuses with 503 on a public host in production when no proxy header is configured: a plain message for the visitor, the reason in the log", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    const logs: string[] = [];
    const err = await limitByIp(req({}), newLimit(), { redis: deadRedis(), log: (m) => logs.push(m) }).catch((e) => e);
    expect(err).toMatchObject({ status: 503, code: "PROXY_NOT_CONFIGURED", message: QUICK_AUDIT_UNAVAILABLE });
    expect(err.message).toBe("Free audits are temporarily unavailable. Please try again later, or open the sample audit.");
    expect(err.message).not.toMatch(/TRUSTED_PROXY_HEADER|proxy|header/i);
    expect(logs).toEqual([expect.stringMatching(/^\[site-sentry\] quick audit refused \(503 PROXY_NOT_CONFIGURED\): TRUSTED_PROXY_HEADER is not set/)]);
  });

  it("refuses with 503 in production when the configured header is missing, and logs which header", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "cf-connecting-ip");
    const logs: string[] = [];
    await expect(limitByIp(xff("203.0.113.9"), newLimit(), { redis: deadRedis(), log: (m) => logs.push(m) })).rejects.toMatchObject({ status: 503, code: "PROXY_NOT_CONFIGURED", message: QUICK_AUDIT_UNAVAILABLE });
    expect(logs[0]).toContain("cf-connecting-ip");
  });

  it("in production without a proxy header, lets localhost requests through in one shared local bucket and warns once", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    const redis = deadRedis();
    const limit = newLimit();
    const logs: string[] = [];
    const log = (m: string) => logs.push(m);
    try {
      await limitByIp(local(), limit, { redis, log });
      await limitByIp(local({}, "http://127.0.0.1:3000"), limit, { redis, log });
      await limitByIp(local({}, "http://[::1]:3000"), limit, { redis, log });
      await limitByIp(local({}, "http://localhost"), limit, { redis, log });
      await limitByIp(local(), limit, { redis, log });
      // One bucket for all of them: the sixth request is over the limit of 5.
      await expect(limitByIp(local({}, "http://127.0.0.1"), limit, { redis, log })).rejects.toMatchObject({ status: 429 });
      const warnings = logs.filter((m) => m.includes("local requests (localhost) share one rate-limit bucket"));
      expect(warnings).toHaveLength(1);
    } finally {
      redis.disconnect();
    }
  });

  it("treats the headers `next start` adds to a direct local request as local", () => {
    // Next fills these from the socket and Host when the client sent none (base-server.js).
    const next = (host: string, socket: string) => req({ host, "x-forwarded-host": host, "x-forwarded-port": "3000", "x-forwarded-proto": "http", "x-forwarded-for": socket });
    expect(isLocalRequest(next("localhost:3000", "::1"))).toBe(true);
    expect(isLocalRequest(next("127.0.0.1:3000", "127.0.0.1"))).toBe(true);
    expect(isLocalRequest(next("localhost:3000", "::ffff:127.0.0.1"))).toBe(true);
    expect(isLocalRequest(next("[::1]:3000", "::1"))).toBe(true);
  });

  it("does not treat a proxied request as local, even when the proxy sends Host: localhost", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    const proxied: Record<string, string>[] = [
      { "x-forwarded-for": "203.0.113.9" },
      { "x-forwarded-for": "203.0.113.9, 127.0.0.1" },
      { "x-forwarded-for": "::1", "x-forwarded-host": "audit.example.com" },
      { "x-real-ip": "127.0.0.1" },
      { forwarded: "for=203.0.113.9" },
      { "cf-connecting-ip": "203.0.113.9" },
    ];
    for (const headers of proxied) {
      const r = local(headers);
      expect(isLocalRequest(r), JSON.stringify(headers)).toBe(false);
      await expect(limitByIp(r, newLimit(), { redis: deadRedis(), log: () => {} })).rejects.toMatchObject({ status: 503 });
    }
  });

  it("recognises loopback hosts only", () => {
    expect(isLocalRequest(local())).toBe(true);
    expect(isLocalRequest(local({}, "http://127.0.0.1:8080"))).toBe(true);
    expect(isLocalRequest(local({}, "http://[::1]"))).toBe(true);
    expect(isLocalRequest(req({}))).toBe(false);
    expect(isLocalRequest(local({}, "http://localhost.example.com"))).toBe(false);
    expect(isLocalRequest(req({ host: "127.0.0.2:3000" }))).toBe(true); // all of 127.0.0.0/8 is loopback
    expect(isLocalRequest(req({ host: "10.0.0.5:3000" }))).toBe(false);
    expect(isLocalRequest(req({ host: "audit.example.com" }, "http://localhost"))).toBe(false); // the Host header wins
  });

  it("uses the configured proxy header, not the local bucket, when TRUSTED_PROXY_HEADER is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TRUSTED_PROXY_HEADER", "cf-connecting-ip");
    await expect(limitByIp(local(), newLimit(), { redis: deadRedis(), log: () => {} })).rejects.toMatchObject({ status: 503 });
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
