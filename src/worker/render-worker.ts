// Standalone render worker: `npm run worker:render`. The crawl worker also runs one in-process unless
// RENDER_WORKER=off; use this to run browsers on their own machine (RENDER_BROWSERS, default 1, max 4).
import { Redis } from "ioredis";
import { createDb } from "../lib/db/client";
import { redisConnection } from "../lib/crawl/v2/queue";
import { workerFetchPolicy } from "../lib/crawl/v2/fetch-policy";
import { createSafeFetch } from "../lib/fetch/safe-fetch";
import { createAnalysisQueue } from "../lib/rules/queue";
import { renderBrowsers } from "../lib/render/pool";
import { createRenderQueue, enqueueRender, renderQueueName, startRenderWorker } from "../lib/render/queue";
import { unrenderedCrawls } from "../lib/render/run";
import { blobStoreFromEnv } from "../lib/snapshot/blob-store";

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
}

const numEnv = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

async function main() {
  const db = createDb(undefined, 4);
  const connection = redisConnection();
  const queue = createRenderQueue(connection);
  const analysisQueue = createAnalysisQueue(connection);
  const redis = new Redis({ ...connection, maxRetriesPerRequest: null });
  const shutdown = new AbortController();
  const unrendered = await unrenderedCrawls(db);
  for (const id of unrendered) await enqueueRender(queue, id);
  const { worker, pool } = startRenderWorker({
    db,
    fetch: createSafeFetch(workerFetchPolicy()),
    store: blobStoreFromEnv(),
    analysisQueue,
    redis,
    politeness: { maxConcurrency: numEnv("CRAWLER_HOST_CONCURRENCY", 3), ratePerSecond: numEnv("CRAWLER_HOST_RATE", 5), keyPrefix: process.env.CRAWLER_THROTTLE_PREFIX || undefined },
    browsers: renderBrowsers(),
    connection,
    signal: shutdown.signal,
    log,
  });
  log("render.boot", { queue: renderQueueName(), browsers: pool.size, enqueued: unrendered.length });
  const stop = async (signal: string) => {
    log("render.stopping", { signal });
    shutdown.abort();
    await worker.close();
    await pool.close();
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
