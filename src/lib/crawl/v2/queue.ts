// BullMQ wiring for crawler v2. A job only says "run crawl X"; all crawl state lives in Postgres, so a lost,
// duplicated or redelivered job can never cause a second fetch (docs/CRAWLER-STATES.md).
import { Queue, type ConnectionOptions } from "bullmq";

export const DEFAULT_REDIS_URL = "redis://127.0.0.1:6379";

export interface CrawlJob {
  crawlId: string;
}

export function crawlQueueName(): string {
  return process.env.CRAWL_QUEUE_NAME ?? "crawl";
}

/** ioredis options from REDIS_URL. BullMQ sets maxRetriesPerRequest: null itself for blocking connections. */
export function redisConnection(raw = process.env.REDIS_URL ?? DEFAULT_REDIS_URL): ConnectionOptions {
  const u = new URL(raw);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
    ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    ...(u.pathname.length > 1 ? { db: Number(u.pathname.slice(1)) } : {}),
    ...(u.protocol === "rediss:" ? { tls: {} } : {}),
  };
}

export function createCrawlQueue(connection = redisConnection()): Queue<CrawlJob> {
  return new Queue<CrawlJob>(crawlQueueName(), { connection });
}

/**
 * Ask a worker to run (or continue) a crawl. The job id is the crawl id, so while a job for this crawl is waiting
 * or active, adding another is a no-op; finished jobs are removed so the crawl can be enqueued again after a pause.
 */
export async function enqueueCrawl(queue: Queue<CrawlJob>, crawlId: string): Promise<void> {
  await queue.add("crawl", { crawlId }, { jobId: crawlId, removeOnComplete: true, removeOnFail: true, attempts: 1 });
}
