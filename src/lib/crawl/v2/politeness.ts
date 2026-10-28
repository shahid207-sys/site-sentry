// Per-host politeness for crawler v2 (docs/SPEC.md "Crawler engine → Politeness"):
// at most 3 requests in flight per host, at most 5 requests per second, and an adaptive throttle that halves
// concurrency and backs off exponentially on 429, 503 or a p95 response time over 3 s. Retry-After and
// robots.txt Crawl-delay are honoured. Not specified by the spec, and chosen here:
// - With Retry-After, the host pauses for exactly that long (at least the 1 s base). Without it, the pause doubles
//   from 1 s on each throttling signal and halves on each normal response.
// - Concurrency recovers additively: +1 after a full window of normal responses, up to the configured maximum.
// - A host pause lasts at most maxBackoffMs (60 s), and Crawl-delay at most 60 s, so one header cannot stall a crawl
//   for hours. The runner does not retry a URL whose Retry-After is longer than that.
//
// The state lives in Redis, so every worker process (and every crawl) hitting one host shares one budget. Each
// decision is one Lua script, atomic in Redis. A slot is a lease in a sorted set, scored by its expiry, so a slot
// held by a killed worker comes back after `leaseMs` instead of leaking. Time is Redis's clock (TIME), so clock skew
// between worker machines cannot break the spacing; tests pass their own clock instead.
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";

export const DEFAULT_HOST_CONCURRENCY = 3;
export const DEFAULT_RATE_PER_SECOND = 5;
export const SLOW_P95_MS = 3000;
/** Crawl-delay values above this are capped so a hostile robots.txt cannot stall a crawl indefinitely. */
export const MAX_CRAWL_DELAY_MS = 60_000;
/** A slot not released within this long is presumed lost (worker killed) and freed. Above the 30 s request timeout. */
export const DEFAULT_SLOT_LEASE_MS = 60_000;
/** A host's Redis state expires this long after its last write, even if no crawl detached (a killed worker). */
export const DEFAULT_STATE_TTL_MS = 3_600_000;
/** HostThrottle.events keeps at most this many slow-downs. */
export const MAX_EVENTS = 100;
/** How often a lane blocked on the concurrency cap re-checks Redis for a slot freed by another process. */
const POLL_MS = 50;

export interface ThrottleOptions {
  maxConcurrency?: number;
  ratePerSecond?: number;
  crawlDelayMs?: number | null;
  slowP95Ms?: number;
  /** Latency samples per p95 judgement, and normal responses needed before concurrency grows again. */
  window?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
  leaseMs?: number;
  /** Idle TTL of the host's Redis keys. */
  stateTtlMs?: number;
  /** Redis key prefix (tests isolate themselves with their own). */
  keyPrefix?: string;
  /** A fake clock for tests. Without it the throttle uses Redis's clock. */
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface ThrottleOutcome {
  status?: number | null;
  elapsedMs?: number | null;
  retryAfterMs?: number | null;
}

export interface ThrottleEvent {
  at: number;
  reason: "429" | "503" | "slow_p95";
  concurrency: number;
  pausedForMs: number;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort() {
      clearTimeout(t);
      reject(signal!.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });

// KEYS: 1 state hash, 2 slot leases (zset scored by expiry), 3 latency samples (list), 4 crawls using the host (set).
// ARGV[1]: now, or -1 for Redis TIME. ARGV[2]: idle TTL ms. Every write refreshes the TTL on all four keys (done), so
// the state of a host nobody crawls any more disappears on its own even if no crawl ever detached cleanly.
const PRELUDE = `
local function clock(a)
  local n = tonumber(a)
  if n >= 0 then return n end
  local t = redis.call('TIME')
  return tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
end
local function num(field, default)
  local v = redis.call('HGET', KEYS[1], field)
  if v then return tonumber(v) end
  return default
end
local function done(r)
  for i = 1, 4 do redis.call('PEXPIRE', KEYS[i], ARGV[2]) end
  return r
end
local now = clock(ARGV[1])
`;

// ARGV: now, ttl, max, rate interval ms, lease id, lease ms. Returns {1, 0} with the slot taken, else {0, wait ms} (-1: full).
const ACQUIRE = `${PRELUDE}
local max = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local limit = math.min(num('limit', max), max)
if redis.call('ZCARD', KEYS[2]) >= limit then return {0, -1} end
local wait = math.max(num('nextAt', 0), num('pausedUntil', 0)) - now
if wait > 0 then return {0, math.ceil(wait)} end
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[6]), ARGV[5])
redis.call('HSET', KEYS[1], 'nextAt', now + math.max(tonumber(ARGV[4]), num('crawlDelay', 0)), 'limit', limit)
return done({1, 0})
`;

// ARGV: now, ttl, max, lease id, status (-1: no request sent), elapsed (-1), retry-after (-1), slow ms, window, base,
// max backoff. Returns {0} or {1, reason, new limit, pause ms, now} when the host was slowed down.
const RELEASE = `${PRELUDE}
local max = tonumber(ARGV[3])
redis.call('ZREM', KEYS[2], ARGV[4])
local status, elapsed, ra = tonumber(ARGV[5]), tonumber(ARGV[6]), tonumber(ARGV[7])
local slow, window, base, maxb = tonumber(ARGV[8]), tonumber(ARGV[9]), tonumber(ARGV[10]), tonumber(ARGV[11])
if status < 0 then return {0} end
if elapsed >= 0 then
  redis.call('RPUSH', KEYS[3], elapsed)
  redis.call('LTRIM', KEYS[3], -window, -1)
end
local reason = false
if status == 429 then reason = '429' elseif status == 503 then reason = '503' else
  local lats = redis.call('LRANGE', KEYS[3], 0, -1)
  if #lats >= window then
    local s = {}
    for i, v in ipairs(lats) do s[i] = tonumber(v) end
    table.sort(s)
    if s[math.min(#s, math.ceil(#s * 0.95))] > slow then reason = 'slow_p95' end
  end
end
local limit = math.min(num('limit', max), max)
local backoff, streak = num('backoff', 0), num('okStreak', 0)
if reason then
  limit = math.max(1, math.floor(limit / 2))
  local pause
  if ra >= 0 then
    pause = math.min(maxb, math.max(base, ra)) -- the server said how long
  else
    if backoff > 0 then backoff = math.min(maxb, backoff * 2) else backoff = base end
    pause = backoff
  end
  redis.call('HSET', KEYS[1], 'limit', limit, 'backoff', backoff, 'okStreak', 0, 'pausedUntil', math.max(num('pausedUntil', 0), now + pause))
  if reason == 'slow_p95' then redis.call('DEL', KEYS[3]) end -- judge the slower pace on fresh samples
  return done({1, reason, limit, pause, now})
end
if elapsed > slow then
  redis.call('HSET', KEYS[1], 'okStreak', 0) -- a slow response is not a normal one, even before p95 can judge
  return done({0})
end
-- Each normal response halves the backoff, so a short burst of 429s does not leave the host on a long pause.
if backoff / 2 < base then backoff = 0 else backoff = backoff / 2 end
streak = streak + 1
if streak >= window then
  streak = 0
  if limit < max then limit = limit + 1 end
end
redis.call('HSET', KEYS[1], 'limit', limit, 'backoff', backoff, 'okStreak', streak)
return done({0})
`;

// ARGV: now, ttl, crawl-delay ms.
const CRAWL_DELAY = `${PRELUDE}
redis.call('HSET', KEYS[1], 'crawlDelay', ARGV[3])
return done(1)
`;

// ARGV: now, ttl, crawl id.
const ATTACH = `${PRELUDE}
redis.call('SADD', KEYS[4], ARGV[3])
return done(1)
`;

// ARGV: now, ttl, crawl id. When no other crawl uses the host and no slot is held, the state is deleted, or, while
// the host is still paused or spaced (backoff, Retry-After, Crawl-delay), set to expire exactly when that hold ends.
// Returns {0, -1} still in use, {1, 0} deleted, {2, ms} expires in ms.
const DETACH = `${PRELUDE}
redis.call('SREM', KEYS[4], ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if redis.call('SCARD', KEYS[4]) > 0 or redis.call('ZCARD', KEYS[2]) > 0 then return done({0, -1}) end
local hold = math.ceil(math.max(num('nextAt', 0), num('pausedUntil', 0)) - now)
if hold <= 0 then
  redis.call('DEL', KEYS[1], KEYS[2], KEYS[3], KEYS[4])
  return {1, 0}
end
for i = 1, 4 do redis.call('PEXPIRE', KEYS[i], hold) end
return {2, hold}
`;

// ARGV: now, ttl, max. Returns {slots in flight, limit, paused until, backoff}. Read-only: does not refresh the TTL.
const SNAPSHOT = `${PRELUDE}
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
local max = tonumber(ARGV[3])
return {redis.call('ZCARD', KEYS[2]), math.min(num('limit', max), max), num('pausedUntil', 0), num('backoff', 0)}
`;

type ThrottleRedis = Redis & {
  throttleAcquire(...args: (string | number)[]): Promise<[number, number]>;
  throttleRelease(...args: (string | number)[]): Promise<[0] | [1, ThrottleEvent["reason"], number, number, number]>;
  throttleCrawlDelay(...args: (string | number)[]): Promise<number>;
  throttleSnapshot(...args: (string | number)[]): Promise<[number, number, number, number]>;
  throttleAttach(...args: (string | number)[]): Promise<number>;
  throttleDetach(...args: (string | number)[]): Promise<[0 | 1 | 2, number]>;
};

const scripted = new WeakSet<Redis>();
function withScripts(redis: Redis): ThrottleRedis {
  if (!scripted.has(redis)) {
    redis.defineCommand("throttleAcquire", { numberOfKeys: 4, lua: ACQUIRE });
    redis.defineCommand("throttleRelease", { numberOfKeys: 4, lua: RELEASE });
    redis.defineCommand("throttleCrawlDelay", { numberOfKeys: 4, lua: CRAWL_DELAY });
    redis.defineCommand("throttleSnapshot", { numberOfKeys: 4, lua: SNAPSHOT });
    redis.defineCommand("throttleAttach", { numberOfKeys: 4, lua: ATTACH });
    redis.defineCommand("throttleDetach", { numberOfKeys: 4, lua: DETACH });
    scripted.add(redis);
  }
  return redis as ThrottleRedis;
}

/** Lanes in this process waiting for a slot on a host; a release here wakes them at once (others poll). */
const waiting = new Map<string, Set<() => void>>();

/** A host's shared politeness budget. Cheap to create; all instances for one host (in any process) share state. */
export class HostThrottle {
  readonly max: number;
  /** Slow-downs this instance caused, newest last (capped). */
  readonly events: ThrottleEvent[] = [];
  private crawlDelayMs: number;
  private readonly redis: ThrottleRedis;
  private readonly keys: [string, string, string, string];
  private readonly rate: number;
  private readonly slowMs: number;
  private readonly window: number;
  private readonly baseBackoff: number;
  private readonly maxBackoff: number;
  private readonly leaseMs: number;
  private readonly ttlMs: number;
  private readonly now: (() => number) | null;
  private readonly sleep: NonNullable<ThrottleOptions["sleep"]>;

  constructor(redis: Redis, host: string, opts: ThrottleOptions = {}) {
    this.redis = withScripts(redis);
    const base = `${opts.keyPrefix ?? "crawl:host:"}{${host}}`;
    this.keys = [`${base}:state`, `${base}:slots`, `${base}:latency`, `${base}:crawls`];
    this.max = opts.maxConcurrency ?? DEFAULT_HOST_CONCURRENCY;
    this.rate = opts.ratePerSecond ?? DEFAULT_RATE_PER_SECOND;
    this.crawlDelayMs = Math.min(MAX_CRAWL_DELAY_MS, opts.crawlDelayMs ?? 0);
    this.slowMs = opts.slowP95Ms ?? SLOW_P95_MS;
    this.window = opts.window ?? 20;
    this.baseBackoff = opts.baseBackoffMs ?? 1000;
    this.maxBackoff = opts.maxBackoffMs ?? 60_000;
    this.leaseMs = opts.leaseMs ?? DEFAULT_SLOT_LEASE_MS;
    this.ttlMs = opts.stateTtlMs ?? DEFAULT_STATE_TTL_MS;
    this.now = opts.now ?? null;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  private get clock() {
    return this.now ? this.now() : -1;
  }

  /** Minimum gap between request starts: the rate cap or Crawl-delay, whichever is longer. */
  get intervalMs(): number {
    return Math.max(1000 / this.rate, this.crawlDelayMs);
  }

  /** Set the host's robots.txt Crawl-delay (shared with every other crawler of the host). */
  async setCrawlDelay(ms: number | null): Promise<void> {
    this.crawlDelayMs = Math.min(MAX_CRAWL_DELAY_MS, ms ?? 0);
    await this.redis.throttleCrawlDelay(...this.keys, this.clock, this.ttlMs, this.crawlDelayMs);
  }

  /** Wait for a request slot and return it. Rejects with the signal's reason if aborted while waiting. */
  async acquire(signal?: AbortSignal): Promise<string> {
    const slot = randomUUID();
    for (;;) {
      signal?.throwIfAborted();
      const pending = this.redis.throttleAcquire(...this.keys, this.clock, this.ttlMs, this.max, 1000 / this.rate, slot, this.leaseMs);
      let got: [number, number];
      try {
        got = await abortable(pending, signal);
      } catch (e) {
        // Aborted while Redis was answering: if the slot was granted after all, give it back.
        void pending.then(([ok]) => (ok ? this.release(slot) : undefined)).catch(() => {});
        throw e;
      }
      const [ok, wait] = got;
      if (ok) return slot;
      if (wait < 0) await this.untilReleased(signal);
      else await this.sleep(wait, signal);
    }
  }

  /** Return a slot. Pass the response (or nothing, if no request was sent) so the throttle can adapt. */
  async release(slot: string, o: ThrottleOutcome = {}): Promise<void> {
    try {
      const r = await this.redis.throttleRelease(
        ...this.keys,
        this.clock,
        this.ttlMs,
        this.max,
        slot,
        o.status ?? -1,
        o.elapsedMs ?? -1,
        o.retryAfterMs ?? -1,
        this.slowMs,
        this.window,
        this.baseBackoff,
        this.maxBackoff,
      );
      if (r[0] === 1) {
        this.events.push({ at: r[4], reason: r[1], concurrency: r[2], pausedForMs: r[3] });
        if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
      }
    } finally {
      for (const wake of waiting.get(this.keys[1]) ?? []) wake();
    }
  }

  /** Record that a crawl is using the host, so another crawl ending does not prune state this one relies on. */
  async attach(crawlId: string): Promise<void> {
    await this.redis.throttleAttach(...this.keys, this.clock, this.ttlMs, crawlId);
  }

  /**
   * A crawl stopped using the host. If it was the last one and no slot is held, the host's state is deleted, or set to
   * expire when its current pause or spacing ends.
   */
  async detach(crawlId: string): Promise<"in_use" | "deleted" | "expiring"> {
    const [r] = await this.redis.throttleDetach(...this.keys, this.clock, this.ttlMs, crawlId);
    return r === 0 ? "in_use" : r === 1 ? "deleted" : "expiring";
  }

  /** The host's Redis keys, for tests and diagnostics. */
  get redisKeys(): readonly string[] {
    return this.keys;
  }

  /** The host's shared state, for tests and diagnostics. */
  async snapshot(): Promise<{ inFlight: number; limit: number; pausedUntil: number; backoffMs: number }> {
    const [inFlight, limit, pausedUntil, backoffMs] = await this.redis.throttleSnapshot(...this.keys, this.clock, this.ttlMs, this.max);
    return { inFlight, limit, pausedUntil, backoffMs };
  }

  /** Wait until a slot is released in this process, or POLL_MS for one released elsewhere. */
  private untilReleased(signal?: AbortSignal): Promise<void> {
    const key = this.keys[1];
    return new Promise<void>((resolve, reject) => {
      const set = waiting.get(key) ?? new Set();
      waiting.set(key, set);
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        set.delete(done);
        if (!set.size) waiting.delete(key);
      };
      const wake = () => (done(), resolve());
      const onAbort = () => (done(), reject(signal!.reason));
      const timer = setTimeout(wake, POLL_MS);
      set.add(wake);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}

function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => (signal.removeEventListener("abort", onAbort), resolve(v)),
      (e) => (signal.removeEventListener("abort", onAbort), reject(e)),
    );
  });
}

/** Retry-After as milliseconds from now: delta-seconds or an HTTP date. Null when absent or unparseable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}
