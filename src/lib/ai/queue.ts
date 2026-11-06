// BullMQ wiring for the AI analysis job. It has its own queue and runs after the rules, so a slow or failing model call
// never holds up an audit's results. Opt-in per project: a crawl gets a job only if its config says so.
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { redisConnection } from "../crawl/v2/queue";
import { aiClientFromEnv } from "./client";
import { markAiFailed, markAiQueued, runAiAnalysis, type AiClient } from "./run";

export interface AiJob {
  crawlId: string;
}

export function aiQueueName(): string {
  return process.env.AI_QUEUE_NAME ?? "ai-analysis";
}

export function createAiQueue(connection: ConnectionOptions = redisConnection()): Queue<AiJob> {
  return new Queue<AiJob>(aiQueueName(), { connection });
}

export async function enqueueAi(db: Pick<Db, "execute">, queue: Queue<AiJob>, crawlId: string, auditId: string): Promise<void> {
  await markAiQueued(db, auditId, crawlId);
  // removeOnFail, so a later retry from the UI or script can add the same job id again.
  await queue.add("ai", { crawlId }, { jobId: `ai_${crawlId}`, removeOnComplete: true, removeOnFail: true, attempts: 3, backoff: { type: "exponential", delay: 30_000 } });
}

/** After the rules: queue the job if this is an audit crawl of a project that turned AI analysis on. */
export async function enqueueAiIfEnabled(db: Pick<Db, "execute">, queue: Queue<AiJob>, crawlId: string): Promise<boolean> {
  const row = (await db.execute(sql`select audit_id, kind, config->>'aiAnalysis' as ai from crawls where id = ${crawlId}::uuid`)).rows[0] as { audit_id: string; kind: string; ai: string | null } | undefined;
  if (!row || row.kind !== "audit" || row.ai !== "true") return false;
  await enqueueAi(db, queue, crawlId, row.audit_id);
  return true;
}

export function startAiWorker(opts: { db: Db; connection?: ConnectionOptions; log: (event: string, data?: Record<string, unknown>) => void; client?: AiClient | null }): Worker<AiJob> {
  const client = opts.client === undefined ? aiClientFromEnv() : opts.client;
  const worker = new Worker<AiJob>(aiQueueName(), async (job) => runAiAnalysis(opts.db, job.data.crawlId, { client, log: opts.log }), {
    connection: opts.connection ?? redisConnection(),
    concurrency: 1,
    lockDuration: 300_000,
  });
  worker.on("failed", (job, e) => {
    opts.log("ai.job_failed", { crawlId: job?.data.crawlId, attemptsMade: job?.attemptsMade, message: e.message });
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) void markAiFailed(opts.db, job.data.crawlId, "The Claude API could not be reached or returned an error.").catch(() => {});
  });
  worker.on("error", (e) => opts.log("ai.worker_error", { message: e.message }));
  return worker;
}
