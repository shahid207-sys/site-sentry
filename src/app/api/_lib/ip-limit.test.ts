import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createLimiterRedis, limitByIp } from "./ip-limit";

const req = (ip: string) => new NextRequest("http://localhost/api/live/audits/quick", { method: "POST", headers: { "x-forwarded-for": ip } });

describe("limitByIp without Redis", () => {
  it("falls back to the in-process limiter within a second, logs it, and still enforces the limit", async () => {
    const redis = createLimiterRedis("redis://127.0.0.1:1"); // nothing listens on port 1
    redis.on("error", () => {});
    const logs: string[] = [];
    const limit = { key: `rl:test:${randomUUID()}`, limit: 5, windowMs: 60_000, message: (s: number) => `wait ${s}s` };
    const ip = "192.0.2.10";
    try {
      const t0 = Date.now();
      await limitByIp(req(ip), limit, { redis, log: (m) => logs.push(m) });
      expect(Date.now() - t0).toBeLessThan(1_000);
      expect(logs[0]).toMatch(new RegExp(`^\\[site-sentry\\] rate limit ${limit.key}: Redis unreachable \\(.+\\); using this process's in-memory limiter\\.$`));
      for (let i = 2; i <= 5; i++) await limitByIp(req(ip), limit, { redis, log: (m) => logs.push(m) });
      await expect(limitByIp(req(ip), limit, { redis, log: (m) => logs.push(m) })).rejects.toMatchObject({ status: 429, message: expect.stringMatching(/^wait \d+s$/) });
      await limitByIp(req("192.0.2.11"), limit, { redis, log: (m) => logs.push(m) }); // other IPs are unaffected
      expect(logs).toHaveLength(7);
    } finally {
      redis.disconnect();
    }
  });
});
