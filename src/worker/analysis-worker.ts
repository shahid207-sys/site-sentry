// Standalone analysis worker: `npm run worker:analysis`. The crawl worker also runs one in-process unless
// ANALYSIS_WORKER=off; use this to scale analysis separately from crawling.
import { createDb } from "../lib/db/client";
import { redisConnection } from "../lib/crawl/v2/queue";
import { workerFetchPolicy } from "../lib/crawl/v2/fetch-policy";
import { analysisQueueName, createAnalysisQueue, enqueueAnalysis, startAnalysisWorker, unanalysedCrawls } from "../lib/rules/queue";
import { createAiQueue, enqueueAiIfEnabled, startAiWorker } from "../lib/ai/queue";
import { afterAnalysed } from "../lib/schedule/deliver";

function log(event: string, data: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...data }));
}

async function main() {
  const db = createDb(undefined, 4);
  const connection = redisConnection();
  const queue = createAnalysisQueue(connection);
  const aiQueue = createAiQueue(connection);
  const unanalysed = await unanalysedCrawls(db);
  for (const id of unanalysed) await enqueueAnalysis(queue, id);
  const n = Number(process.env.ANALYSIS_CONCURRENCY);
  const worker = startAnalysisWorker({
    db,
    connection,
    concurrency: Number.isFinite(n) && n > 0 ? n : 1,
    log,
    afterAnalysed: async (crawlId) => {
      await enqueueAiIfEnabled(db, aiQueue, crawlId);
      await afterAnalysed(db, crawlId, { policy: workerFetchPolicy(), log, appUrl: process.env.APP_URL });
    },
  });
  const aiWorker = startAiWorker({ db, connection, log });
  log("analysis.boot", { queue: analysisQueueName(), enqueued: unanalysed.length });
  const stop = async (signal: string) => {
    log("analysis.stopping", { signal });
    await worker.close();
    await aiWorker.close();
    await queue.close();
    await aiQueue.close();
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
