// Per-host politeness for crawler v2 (docs/SPEC.md "Crawler engine → Politeness"):
// at most 3 requests in flight per host, at most 5 requests per second, and an adaptive throttle that halves
// concurrency and backs off exponentially on 429, 503 or a p95 response time over 3 s. Retry-After and
// robots.txt Crawl-delay are honoured. Not specified by the spec, and chosen here:
// - Recovery is additive: +1 concurrency after a full window of normal responses, up to the configured maximum.
// - A host pause (backoff or Retry-After) lasts at most maxBackoffMs (60 s), and Crawl-delay at most 60 s, so one
//   header cannot stall a crawl for hours. The runner does not retry a URL whose Retry-After is longer than that.


export const DEFAULT_HOST_CONCURRENCY = 3;
export const DEFAULT_RATE_PER_SECOND = 5;
export const SLOW_P95_MS = 3000;
/** Crawl-delay values above this are capped so a hostile robots.txt cannot stall a crawl indefinitely. */
export const MAX_CRAWL_DELAY_MS = 60_000;

export interface ThrottleOptions {
  maxConcurrency?: number;
  ratePerSecond?: number;
  crawlDelayMs?: number | null;
  slowP95Ms?: number;
  /** Latency samples per p95 judgement, and normal responses needed before concurrency grows again. */
  window?: number;
  baseBackoffMs?: number;
  maxBackoffMs?: number;
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

export function p95(samples: number[]): number {
  if (!samples.length) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
}

export class HostThrottle {
  readonly max: number;
  limit: number;
  inFlight = 0;
  readonly events: ThrottleEvent[] = [];
  private crawlDelayMs: number;
  private readonly rate: number;
  private readonly slowMs: number;
  private readonly window: number;
  private readonly baseBackoff: number;
  private readonly maxBackoff: number;
  private readonly now: () => number;
  private readonly sleep: NonNullable<ThrottleOptions["sleep"]>;
  private nextAt = 0;
  private pausedUntil = 0;
  private backoffMs = 0;
  private okStreak = 0;
  private latencies: number[] = [];
  private waiters: (() => void)[] = [];

  constructor(opts: ThrottleOptions = {}) {
    this.max = opts.maxConcurrency ?? DEFAULT_HOST_CONCURRENCY;
    this.limit = this.max;
    this.rate = opts.ratePerSecond ?? DEFAULT_RATE_PER_SECOND;
    this.crawlDelayMs = Math.min(MAX_CRAWL_DELAY_MS, opts.crawlDelayMs ?? 0);
    this.slowMs = opts.slowP95Ms ?? SLOW_P95_MS;
    this.window = opts.window ?? 20;
    this.baseBackoff = opts.baseBackoffMs ?? 1000;
    this.maxBackoff = opts.maxBackoffMs ?? 60_000;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Minimum gap between request starts: the rate cap or Crawl-delay, whichever is longer. */
  get intervalMs(): number {
    return Math.max(1000 / this.rate, this.crawlDelayMs);
  }

  setCrawlDelay(ms: number | null) {
    this.crawlDelayMs = Math.min(MAX_CRAWL_DELAY_MS, ms ?? 0);
  }

  /** Wait for a request slot. Rejects with the signal's reason if aborted while waiting. */
  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      signal?.throwIfAborted();
      const now = this.now();
      const wait = Math.max(this.nextAt, this.pausedUntil) - now;
      if (this.inFlight < this.limit && wait <= 0) {
        this.inFlight++;
        this.nextAt = now + this.intervalMs;
        return;
      }
      if (this.inFlight >= this.limit) {
        await new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(signal!.reason);
          signal?.addEventListener("abort", onAbort, { once: true });
          this.waiters.push(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve();
          });
        });
      } else {
        await this.sleep(wait, signal);
      }
    }
  }

  /** Return a slot. Pass the response (or nothing, if no request was sent) so the throttle can adapt. */
  release(o: ThrottleOutcome = {}): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.adapt(o);
    this.waiters.shift()?.();
  }

  private adapt(o: ThrottleOutcome) {
    if (o.status == null) return;
    if (o.elapsedMs != null) {
      this.latencies.push(o.elapsedMs);
      if (this.latencies.length > this.window) this.latencies.shift();
    }
    const reason: ThrottleEvent["reason"] | null =
      o.status === 429 ? "429" : o.status === 503 ? "503" : this.latencies.length >= this.window && p95(this.latencies) > this.slowMs ? "slow_p95" : null;
    if (reason) {
      this.limit = Math.max(1, Math.floor(this.limit / 2));
      this.backoffMs = this.backoffMs ? Math.min(this.maxBackoff, this.backoffMs * 2) : this.baseBackoff;
      const pause = Math.min(this.maxBackoff, Math.max(this.backoffMs, o.retryAfterMs ?? 0));
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + pause);
      this.okStreak = 0;
      if (reason === "slow_p95") this.latencies = []; // judge the slower pace on fresh samples
      this.events.push({ at: this.now(), reason, concurrency: this.limit, pausedForMs: pause });
      return;
    }
    if (o.elapsedMs != null && o.elapsedMs > this.slowMs) {
      this.okStreak = 0; // a slow response is not a normal one, even before the window can judge p95
      return;
    }
    if (++this.okStreak >= this.window) {
      this.okStreak = 0;
      this.backoffMs = Math.floor(this.backoffMs / 2);
      if (this.limit < this.max) this.limit++;
    }
  }
}

/** Retry-After as milliseconds from now: delta-seconds or an HTTP date. Null when absent or unparseable. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+$/.test(v)) return Number(v) * 1000;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - now);
}

const throttles = new Map<string, HostThrottle>();

/** One throttle per host per process, shared by every crawl this worker runs against that host. */
export function throttleFor(host: string, opts: ThrottleOptions = {}): HostThrottle {
  let t = throttles.get(host);
  if (!t) {
    t = new HostThrottle(opts);
    throttles.set(host, t);
  } else if (opts.crawlDelayMs !== undefined) {
    t.setCrawlDelay(opts.crawlDelayMs);
  }
  return t;
}
