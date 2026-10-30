// Crawl worker process (crawler v2). Runs outside Next: `npm run worker`.
// Must not import anything that pulls in `server-only` or Next (workspace.ts, handler.ts).
import { hostname } from "node:os";
import { Worker } from "bullmq";
import { sql } from "drizzle-orm";
import { Redis } from "ioredis";
import { createDb } from "../lib/db/client";
import { createPeerCertReader, createSafeFetch } from "../lib/fetch/safe-fetch";
import { startMemoryLog } from "../lib/memory-log";
import { workerFetchPolicy } from "../lib/crawl/v2/fetch-policy";
import { finalizeUrls, sweep } from "../lib/crawl/v2/frontier";
import { createCrawlQueue, crawlQueueName, enqueueCrawl, redisConnection, type CrawlJob } from "../lib/crawl/v2/queue";
import { runCrawl } from "../lib/crawl/v2/runner";
import { createAnalysisQueue, enqueueAnalysis, startAnalysisWorker, unanalysedCrawls } from "../lib/rules/queue";
import { afterAnalysed } from "../lib/schedule/deliver";

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
  const peerCert = createPeerCertReader(workerFetchPolicy());
  const leaseMs = numEnv("CRAWLER_LEASE_MS", 60_000);
  const shutdown = new AbortController();
  const analysisQueue = createAnalysisQueue(connection);
  // Analysis runs in this process by default; ANALYSIS_WORKER=off leaves it to `npm run worker:analysis`.
  const analysisWorker = process.env.ANALYSIS_WORKER === "off" ? null : startAnalysisWorker({
          db,
          connection,
          concurrency: numEnv("ANALYSIS_CONCURRENCY", 1),
          log,
          afterAnalysed: (crawlId) => afterAnalysed(db, crawlId, { policy: workerFetchPolicy(), log, appUrl: process.env.APP_URL }),
        });

  // Boot reconcile: recover expired claims everywhere, then make sure every unfinished crawl has a job.
  // Runners force-sweep their own crawl once they hold its lock, so a crash is recovered as soon as it is re-run.
  const swept = await sweep(db);
  const open = await db.execute(sql`select id from crawls where status in ('queued', 'running', 'cancelling') order by created_at`);
  for (const row of open.rows as { id: string }[]) await enqueueCrawl(queue, row.id);
  const unanalysed = await unanalysedCrawls(db);
  for (const id of unanalysed) await enqueueAnalysis(analysisQueue, id);
  // WORKER_MEMORY_LOG: RSS and heap every 10 s to that file; past WORKER_MEMORY_LIMIT_MB a heap snapshot is written
  // next to it and the worker stops (exit 3), so a leak fails fast with evidence.
  const memFile = process.env.WORKER_MEMORY_LOG;
  if (memFile) {
    startMemoryLog({
      file: memFile,
      label: "worker",
      limitBytes: numEnv("WORKER_MEMORY_LIMIT_MB", 0) * 1048576 || undefined,
      onLimit: (rss, snapshot) => {
        log("memory.limit", { rssMb: Math.round(rss / 1048576), snapshot });
        process.exit(3);
      },
    });
  }
  log("worker.boot", { owner, queue: crawlQueueName(), swept, reenqueued: open.rows.length, analysisEnqueued: unanalysed.length });

  const worker = new Worker<CrawlJob>(
    crawlQueueName(),
    async (job) => {
      const crawlId = job.data.crawlId;
      log("crawl.start", { crawlId });
      try {
        const run = () => runCrawl({ db, redis, fetch, peerCert, owner, leaseMs, politeness: { maxConcurrency: numEnv("CRAWLER_HOST_CONCURRENCY", 3), ratePerSecond: numEnv("CRAWLER_HOST_RATE", 5), keyPrefix: process.env.CRAWLER_THROTTLE_PREFIX || undefined }, signal: shutdown.signal, log }, crawlId);
        let outcome = await run();
        // A resume that arrived while this job was still winding down from a pause could not enqueue a new job
        // (same job id), so pick it up here.
        while (outcome === "paused" && !shutdown.signal.aborted && (await crawlStatus(crawlId)) === "running") outcome = await run();
        log("crawl.end", { crawlId, outcome });
        if (outcome === "completed" || outcome === "cancelled") await enqueueAnalysis(analysisQueue, crawlId);
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
      // A job whose worker died is handed to another worker after the lock expires (BullMQ stall check), so a
      // takeover takes at most lockDuration + stalledInterval: 25 s + 15 s = 40 s. A live worker renews its lock every
      // lockDuration / 2 (12.5 s); crawling is I/O-bound, so the event loop is never blocked that long.
      // Redelivery is harmless (Postgres holds the state), so allow it as often as needed.
      lockDuration: numEnv("CRAWL_JOB_LOCK_MS", 25_000),
      stalledInterval: numEnv("CRAWL_JOB_STALLED_MS", Math.min(15_000, numEnv("CRAWL_JOB_LOCK_MS", 25_000))),
      maxStalledCount: 100,
    },
  );
  worker.on("error", (e) => log("worker.error", { message: e.message }));

  const stop = async (signal: string) => {
    log("worker.stopping", { signal });
    shutdown.abort();
    await worker.close();
    await analysisWorker?.close();
    await queue.close();
    await analysisQueue.close();
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
