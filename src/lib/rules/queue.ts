// BullMQ wiring for the analysis job (docs/SPEC.md "Phase 2" item 4). A job only says "analyse crawl X"; the
// result lives in Postgres and analyseCrawl replaces it atomically, so a redelivered job is harmless.
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { redisConnection } from "../crawl/v2/queue";
import { analyseCrawl } from "./analyse";

export interface AnalysisJob {
  crawlId: string;
}

export function analysisQueueName(): string {
  return process.env.ANALYSIS_QUEUE_NAME ?? "analysis";
}

export function createAnalysisQueue(connection: ConnectionOptions = redisConnection()): Queue<AnalysisJob> {
  return new Queue<AnalysisJob>(analysisQueueName(), { connection });
}

/** Ask for a crawl to be analysed. While a job for the crawl is waiting or active, adding another is a no-op. */
export async function enqueueAnalysis(queue: Queue<AnalysisJob>, crawlId: string): Promise<void> {
  await queue.add("analysis", { crawlId }, { jobId: `analysis_${crawlId}`, removeOnComplete: true, removeOnFail: 100, attempts: 3, backoff: { type: "exponential", delay: 5_000 } });
}

/** Finished crawls that have never been analysed (a crash between finishing and enqueueing loses nothing). */
export async function unanalysedCrawls(db: Db): Promise<string[]> {
  const r = await db.execute(sql`select id from crawls where status in ('completed', 'cancelled') and analysis is null order by finished_at nulls last`);
  return (r.rows as { id: string }[]).map((x) => x.id);
}

export function startAnalysisWorker(opts: {
  db: Db;
  connection?: ConnectionOptions;
  concurrency?: number;
  log: (event: string, data?: Record<string, unknown>) => void;
  /** Runs after a crawl is analysed (the scheduled-audit regression alert). Its failure is logged, never the job's. */
  afterAnalysed?: (crawlId: string) => Promise<unknown>;
}): Worker<AnalysisJob> {
  const worker = new Worker<AnalysisJob>(
    analysisQueueName(),
    async (job) => {
      const res = await analyseCrawl(opts.db, job.data.crawlId, { log: opts.log });
      if (res.outcome === "analysed" && opts.afterAnalysed) {
        await opts.afterAnalysed(job.data.crawlId).catch((e: Error) => opts.log("analysis.after_failed", { crawlId: job.data.crawlId, message: e.message }));
      }
      return { outcome: res.outcome, pages: res.pages, findings: res.findings, msPerPage: res.msPerPage };
    },
    { connection: opts.connection ?? redisConnection(), concurrency: opts.concurrency ?? 1, lockDuration: 120_000 },
  );
  worker.on("error", (e) => opts.log("analysis.worker_error", { message: e.message }));
  return worker;
}
