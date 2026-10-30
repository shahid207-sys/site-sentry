// BullMQ wiring for the render phase (docs/SPEC.md: "separate queues per worker type so slow renders never block
// fetches"). A job says "render crawl X"; renderCrawl skips pages already rendered, so a redelivered job is harmless.
// When the phase ends (or the crawl does not render), the crawl goes to the analysis queue.
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import type { Redis } from "ioredis";
import { redisConnection } from "../crawl/v2/queue";
import { HostThrottle, type ThrottleOptions } from "../crawl/v2/politeness";
import type { Db } from "../db/client";
import type { Fetcher } from "../fetch/safe-fetch";
import { enqueueAnalysis, type AnalysisJob } from "../rules/queue";
import type { BlobStore } from "../snapshot/blob-store";
import { RenderPool } from "./pool";
import { crawlGate, markRenderFailed, renderCrawl } from "./run";

export interface RenderJob {
  crawlId: string;
}

export const RENDER_JOB_ATTEMPTS = 3;

export function renderQueueName(): string {
  return process.env.RENDER_QUEUE_NAME ?? "render";
}

export function createRenderQueue(connection: ConnectionOptions = redisConnection()): Queue<RenderJob> {
  return new Queue<RenderJob>(renderQueueName(), { connection });
}

/** Ask for a crawl's pages to be rendered. While a job for the crawl is waiting or active, adding another is a no-op. */
export async function enqueueRender(queue: Queue<RenderJob>, crawlId: string): Promise<void> {
  await queue.add("render", { crawlId }, { jobId: `render_${crawlId}`, removeOnComplete: true, removeOnFail: 100, attempts: RENDER_JOB_ATTEMPTS, backoff: { type: "exponential", delay: 10_000 } });
}

export function startRenderWorker(opts: {
  db: Db;
  fetch: Fetcher;
  store: BlobStore;
  analysisQueue: Queue<AnalysisJob>;
  /** Shares each host's politeness state with the crawlers. */
  redis: Redis;
  politeness?: ThrottleOptions;
  browsers: number;
  connection?: ConnectionOptions;
  signal?: AbortSignal;
  log: (event: string, data?: Record<string, unknown>) => void;
}): { worker: Worker<RenderJob>; pool: RenderPool } {
  const pool = new RenderPool({ fetch: opts.fetch, browsers: opts.browsers });
  const worker = new Worker<RenderJob>(
    renderQueueName(),
    async (job) => {
      const crawlId = job.data.crawlId;
      try {
        const outcome = await renderCrawl(
          {
            db: opts.db,
            pool,
            store: opts.store,
            signal: opts.signal,
            log: opts.log,
            gate: ({ origin, robots }) => crawlGate(origin, robots, new HostThrottle(opts.redis, new URL(origin).host, opts.politeness)),
          },
          crawlId,
        );
        if (outcome === "done" || outcome === "skipped") await enqueueAnalysis(opts.analysisQueue, crawlId);
        return outcome;
      } catch (e) {
        const message = (e as Error)?.message ?? String(e);
        opts.log("render.error", { crawlId, attempt: job.attemptsMade + 1, message });
        // The last attempt: analyse without renders rather than never (rendered rules then report the failure).
        if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
          await markRenderFailed(opts.db, crawlId, message);
          await enqueueAnalysis(opts.analysisQueue, crawlId);
        }
        throw e;
      }
    },
    // One crawl at a time: the pool's browsers render its pages in parallel. A render job outlives a crawl job's
    // lock budget easily (20 s a page), so the lock is long; a dead worker's job is taken over after it expires.
    { connection: opts.connection ?? redisConnection(), concurrency: 1, lockDuration: 120_000, maxStalledCount: 100 },
  );
  worker.on("error", (e) => opts.log("render.worker_error", { message: e.message }));
  return { worker, pool };
}
