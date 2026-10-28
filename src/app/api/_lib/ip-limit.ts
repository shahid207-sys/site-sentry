import "server-only";
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import type { NextRequest } from "next/server";
import { redisConnection } from "@/lib/crawl/v2/queue";
import { clientIp, HttpError, rateLimit } from "./handler";

// Per-IP limits that hold across web processes: a sliding window in a Redis sorted set (one member per allowed
// request, scored by time). When Redis cannot be reached, the in-process limiter in handler.ts takes over and the
// fallback is logged, so a Redis outage weakens the limit instead of taking the endpoint down.

export interface WindowResult {
  allowed: boolean;
  /** Requests counted in the window, including this one when allowed. */
  count: number;
  /** When denied: how long until the oldest counted request leaves the window. */
  retryAfterMs: number;
}

/** Count this request against `key` if fewer than `limit` were allowed in the last `windowMs`. Denied requests do not count. */
export async function slidingWindow(redis: Redis, key: string, limit: number, windowMs: number, now = Date.now()): Promise<WindowResult> {
  const member = `${now}-${randomBytes(6).toString("hex")}`; // unique, so two requests in the same millisecond both count
  const res = await redis
    .multi()
    .zremrangebyscore(key, 0, now - windowMs)
    .zadd(key, now, member)
    .zcard(key)
    .zrange(key, "0", "0", "WITHSCORES")
    .pexpire(key, windowMs)
    .exec();
  if (!res) throw new Error("Redis transaction was discarded.");
  const failed = res.find(([err]) => err);
  if (failed) throw failed[0];
  const count = res[2][1] as number;
  if (count <= limit) return { allowed: true, count, retryAfterMs: 0 };
  await redis.zrem(key, member);
  const oldest = Number((res[3][1] as string[])[1] ?? now);
  return { allowed: false, count: count - 1, retryAfterMs: Math.max(0, oldest + windowMs - now) };
}

/**
 * A client that fails fast: no offline queue, one attempt per command and short timeouts, so an unreachable Redis
 * costs the request well under a second before the fallback runs.
 */
export function createLimiterRedis(url = process.env.REDIS_URL): Redis {
  return new Redis({
    ...(redisConnection(url) as object),
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    connectTimeout: 500,
    commandTimeout: 500,
    retryStrategy: (times) => Math.min(times * 500, 5_000),
  });
}

const g = globalThis as unknown as { __ssLimiterRedis?: Redis };
function limiterRedis(): Redis {
  if (!g.__ssLimiterRedis) {
    g.__ssLimiterRedis = createLimiterRedis();
    g.__ssLimiterRedis.on("error", () => {}); // reported per request by limitByIp; avoid unhandled 'error' events
  }
  return g.__ssLimiterRedis;
}

// One connect() per lazy client: concurrent first requests share it instead of racing ("already connecting").
const connecting = new WeakMap<Redis, Promise<void>>();
function connected(redis: Redis): Promise<void> | void {
  if (redis.status !== "wait") return;
  let p = connecting.get(redis);
  if (!p) connecting.set(redis, (p = redis.connect()));
  return p;
}

export interface IpLimit {
  /** Redis key prefix, e.g. "rl:hero-audit". */
  key: string;
  limit: number;
  windowMs: number;
  /** Message for a denied request, given the wait in seconds. */
  message: (waitS: number) => string;
}

export async function limitByIp(req: NextRequest, l: IpLimit, deps: { redis?: Redis; now?: number; log?: (msg: string) => void } = {}): Promise<void> {
  const redis = deps.redis ?? limiterRedis();
  const ip = clientIp(req);
  let result: WindowResult;
  try {
    await connected(redis);
    result = await slidingWindow(redis, `${l.key}:${ip}`, l.limit, l.windowMs, deps.now);
  } catch (e) {
    (deps.log ?? console.warn)(`[site-sentry] rate limit ${l.key}: Redis unreachable (${(e as Error).message}); using this process's in-memory limiter.`);
    rateLimit(req, l.key, l.limit, l.windowMs, l.message);
    return;
  }
  if (!result.allowed) throw new HttpError(429, "RATE_LIMITED", l.message(Math.ceil(result.retryAfterMs / 1000)));
}
