import "server-only";
import { randomBytes } from "node:crypto";
import { Redis } from "ioredis";
import type { NextRequest } from "next/server";
import { redisConnection } from "@/lib/crawl/v2/queue";
import { clientIp, HttpError, rateLimit, trustedProxyHeader } from "./handler";

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

/** What a visitor sees when the client address cannot be established. The reason goes to the server log only. */
export const QUICK_AUDIT_UNAVAILABLE = "Free audits are temporarily unavailable. Please try again later, or open the sample audit.";

/** localhost, 127.0.0.0/8 or ::1 (also IPv4-mapped), with any port or IPv6 brackets removed. */
function isLoopback(hostOrIp: string): boolean {
  let v = hostOrIp.trim().toLowerCase();
  if (v.startsWith("[")) v = v.slice(1, v.indexOf("]"));
  else if (v.split(":").length === 2) v = v.replace(/:\d+$/, ""); // host:port; a bare IPv6 address has more colons
  v = v.replace(/^::ffff:/, "");
  return v === "localhost" || v === "::1" || /^127(\.\d{1,3}){3}$/.test(v);
}

/** Headers Next never sets itself: any of them means a proxy or CDN forwarded the request. */
const PROXY_ONLY_HEADERS = ["forwarded", "x-real-ip", "cf-connecting-ip", "true-client-ip"];

/**
 * True when the request was addressed to a loopback name (localhost, 127.x.x.x or [::1], any port) and nothing
 * forwarded it from elsewhere. Route handlers cannot see the socket, so this reads headers. `next start` itself fills
 * X-Forwarded-For with the socket address and X-Forwarded-Host with Host when they are absent, so those count as local
 * when every address in them is loopback. A public deployment receives its own hostname, and a proxy normally adds the
 * visitor's address, so public traffic does not get here. A client that forges these headers against an exposed port
 * only joins the one bucket every such request shares, which never loosens the limit.
 */
export function isLocalRequest(req: NextRequest): boolean {
  const h = req.headers;
  if (PROXY_ONLY_HEADERS.some((name) => h.has(name))) return false;
  if (!isLoopback(h.get("host") ?? req.nextUrl.host)) return false;
  const fwdHost = h.get("x-forwarded-host");
  if (fwdHost !== null && !fwdHost.split(",").every(isLoopback)) return false;
  const xff = h.get("x-forwarded-for");
  return xff === null || xff.split(",").every(isLoopback);
}

/** Why the client address is unavailable, for logs and the admin health view; null when it is available. */
export function clientAddressProblem(req?: NextRequest): string | null {
  const header = trustedProxyHeader();
  if (!header) return "TRUSTED_PROXY_HEADER is not set, so the client address is unknown; set it to the header your reverse proxy writes the client IP to.";
  if (req && !clientIp(req)) return `The trusted proxy header (${header}) is missing from the request or is not an IP address.`;
  return null;
}

const warned = new Set<string>();
/** Log `msg` once per process (keyed by `key`). */
function warnOnce(key: string, msg: string, log: (m: string) => void) {
  if (warned.has(key)) return;
  warned.add(key);
  log(msg);
}
/** Tests only: forget which one-time warnings were logged. */
export function resetIpLimitWarnings() {
  warned.clear();
}

/**
 * Count this request against the client's IP. The IP comes only from TRUSTED_PROXY_HEADER (see clientIp). Without it:
 * - a local request (see isLocalRequest) shares one "local" bucket, with a one-time warning in the log, so a
 *   production build run on a laptop works;
 * - otherwise production refuses with 503 (a per-IP limit that any client can dodge by sending a header is not a
 *   limit), and other environments put every client in one "shared" bucket.
 * The 503 tells the visitor only that free audits are unavailable; the reason goes to the server log.
 */
export async function limitByIp(req: NextRequest, l: IpLimit, deps: { redis?: Redis; now?: number; log?: (msg: string) => void } = {}): Promise<void> {
  const log = deps.log ?? console.warn;
  let ip = clientIp(req);
  if (!ip && !trustedProxyHeader() && isLocalRequest(req)) {
    warnOnce("local", "[site-sentry] TRUSTED_PROXY_HEADER is not set: local requests (localhost) share one rate-limit bucket. Set it before serving the app on a public host.", log);
    ip = "local";
  }
  if (!ip && process.env.NODE_ENV !== "production") ip = "shared";
  if (!ip) {
    const reason = clientAddressProblem(req) ?? "The client address is unavailable.";
    log(`[site-sentry] quick audit refused (503 PROXY_NOT_CONFIGURED): ${reason}`);
    throw new HttpError(503, "PROXY_NOT_CONFIGURED", QUICK_AUDIT_UNAVAILABLE);
  }
  const redis = deps.redis ?? limiterRedis();
  let result: WindowResult;
  try {
    await connected(redis);
    result = await slidingWindow(redis, `${l.key}:${ip}`, l.limit, l.windowMs, deps.now);
  } catch (e) {
    log(`[site-sentry] rate limit ${l.key}: Redis unreachable (${(e as Error).message}); using this process's in-memory limiter.`);
    rateLimit(req, l.key, l.limit, l.windowMs, l.message);
    return;
  }
  if (!result.allowed) throw new HttpError(429, "RATE_LIMITED", l.message(Math.ceil(result.retryAfterMs / 1000)));
}
