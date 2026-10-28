// Crawl worker process (crawler v2). Runs outside Next: `npm run worker`.
// Must not import anything that pulls in `server-only` or Next (workspace.ts, handler.ts).
import { hostname } from "node:os";
import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { createDb } from "../lib/db/client";
import { createSafeFetch } from "../lib/fetch/safe-fetch";
import { workerFetchPolicy } from "../lib/crawl/v2/fetch-policy";
import { finalizeUrls, sweep } from "../lib/crawl/v2/frontier";
import { createCrawlQueue, crawlQueueName, enqueueCrawl, redisConnection, type CrawlJob } from "../lib/crawl/v2/queue";
import { runCrawl } from "../lib/crawl/v2/runner";

const numEnv = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

const crawlStatus = async (crawlId: string) =>
  ((await db.execute(sql`select status from crawls where id = ${crawlId}::uuid`)).rows[0] as { status: string } | undefined)?.status;

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
}

const db = createDb(undefined, numEnv("CRAWL_DB_POOL", 10));

async function main() {
  const owner = `${hostname()}-${process.pid}`;
  const connection = redisConnection();
  const queue = createCrawlQueue(connection);
  // Per-host politeness state, shared with every other worker. maxRetriesPerRequest null: while Redis is down,
  // throttle calls wait for it to come back (requests stop) rather than fail or run unthrottled.
  const redis = new Redis({ ...connection, maxRetriesPerRequest: null });
  const fetch = createSafeFetch(workerFetchPolicy());
  const leaseMs = numEnv("CRAWLER_LEASE_MS", 60_000);
  const shutdown = new AbortController();

  // Boot reconcile: recover expired claims everywhere, then make sure every unfinished crawl has a job.
  // Runners force-sweep their own crawl once they hold its lock, so a crash is recovered as soon as it is re-run.
  const swept = await sweep(db);
  const open = await db.execute(sql`select id from crawls where status in ('queued', 'running', 'cancelling') order by created_at`);
  for (const row of open.rows as { id: string }[]) await enqueueCrawl(queue, row.id);
  log("worker.boot", { owner, queue: crawlQueueName(), swept, reenqueued: open.rows.length });

  const worker = new Worker<CrawlJob>(
    crawlQueueName(),
    async (job) => {
      const crawlId = job.data.crawlId;
      log("crawl.start", { crawlId });
      try {
        const run = () => runCrawl({ db, redis, fetch, owner, leaseMs, politeness: { maxConcurrency: numEnv("CRAWLER_HOST_CONCURRENCY", 3), ratePerSecond: numEnv("CRAWLER_HOST_RATE", 5), keyPrefix: process.env.CRAWLER_THROTTLE_PREFIX || undefined }, signal: shutdown.signal, log }, crawlId);
        let outcome = await run();
        // A resume that arrived while this job was still winding down from a pause could not enqueue a new job
        // (same job id), so pick it up here.
        while (outcome === "paused" && !shutdown.signal.aborted && (await crawlStatus(crawlId)) === "running") outcome = await run();
        log("crawl.end", { crawlId, outcome });
        return outcome;
      } catch (e) {
        const error = { message: (e as Error)?.message ?? String(e), at: new Date().toISOString() };
        log("crawl.error", { crawlId, ...error });
        const failed = await db.execute(sql`update crawls set status = 'failed', error = ${JSON.stringify(error)}::jsonb, finished_at = now()
          where id = ${crawlId}::uuid and status not in ('completed', 'cancelled', 'failed') returning id`);
        if (failed.rows.length) {
          // A failed crawl is never run again, so its claims can be settled now: every URL ends terminal.
          await sweep(db, crawlId, { force: true });
          await finalizeUrls(db, crawlId, "failed", null, null);
        }
        throw e;
      }
    },
    {
      connection,
      concurrency: numEnv("CRAWL_WORKER_CONCURRENCY", 4),
      // A job whose worker died is handed to another worker after the lock expires (BullMQ stall check).
      // Redelivery is harmless (Postgres holds the state), so allow it as often as needed.
      lockDuration: numEnv("CRAWL_JOB_LOCK_MS", 30_000),
      stalledInterval: numEnv("CRAWL_JOB_LOCK_MS", 30_000),
      maxStalledCount: 100,
    },
  );
  worker.on("error", (e) => log("worker.error", { message: e.message }));

  const stop = async (signal: string) => {
    log("worker.stopping", { signal });
    shutdown.abort();
    await worker.close();
    await queue.close();
    redis.disconnect();
    await db.$client.end();
    process.exit(0);
  };
  process.once("SIGINT", () => void stop("SIGINT"));
  process.once("SIGTERM", () => void stop("SIGTERM"));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
