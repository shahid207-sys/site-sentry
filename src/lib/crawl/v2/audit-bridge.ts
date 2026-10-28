// Connects JSON-store audits (the UI's unit) to crawler v2 crawls in Postgres while CRAWLER_V2=true.
// The crawl is the source of truth for progress and status; the audit record mirrors it on every sync.
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Queue } from "bullmq";
import type { Db } from "../../db/client";
import { crawls } from "../../db/schema";
import type { AuditRun, AuditStatus, CrawlerV2Ref, Workspace } from "../../model";
import type { Store } from "../../store/store";
import { WorkflowError } from "../../workflow/deps";
import { stateCounts } from "./frontier";
import { createCrawlQueue, enqueueCrawl, type CrawlJob } from "./queue";
import type { CrawlConfig } from "./runner";
import { crawlSecretScope, encryptSecret, secretKey } from "./secrets";

export { crawlerV2Enabled } from "./flag";

const g = globalThis as unknown as { __ssCrawlQueue?: Queue<CrawlJob> };
export function getCrawlQueue(): Queue<CrawlJob> {
  g.__ssCrawlQueue ??= createCrawlQueue();
  return g.__ssCrawlQueue;
}

const SKIPPED = ["blocked_robots", "out_of_scope", "excluded_by_rule", "budget_exhausted", "depth_exceeded", "cancelled", "redirected", "non_html"];
const FAILED = ["failed_timeout", "failed_dns", "failed_tls", "failed_network", "interrupted"];
const INSPECTED = ["fetched", "oversized", "analysed"];
const ACTIVE = ["discovered", "queued", "fetching"];

/** Basic auth for a Custom crawl, in plaintext only between the request body and encryption here. */
export interface CrawlAuthInput {
  username: string;
  password: string;
}

/**
 * Create the crawl for a freshly created audit and hand it to the worker queue. The crawl id is made here so the
 * basic-auth password can be encrypted bound to it before the row is written; plaintext never reaches Postgres.
 */
export async function startCrawl(
  db: Db,
  queue: Queue<CrawlJob>,
  store: Store,
  ws: Workspace,
  audit: AuditRun,
  siteOrigin: string,
  opts: { auth?: CrawlAuthInput; env?: Record<string, string | undefined> } = {},
): Promise<AuditRun> {
  const id = randomUUID();
  let auth: CrawlConfig["auth"];
  if (opts.auth) {
    const key = secretKey(opts.env);
    if (!key) throw new WorkflowError("INVALID", "Basic auth needs CRAWLER_SECRET_KEY set on the server, so the password can be stored encrypted.");
    auth = { username: opts.auth.username, password: encryptSecret(opts.auth.password, key, crawlSecretScope(id)) };
  }
  const config: CrawlConfig = {
    seeds: audit.config.urls.length ? audit.config.urls : undefined,
    sitemaps: audit.config.sitemapUrl ? [audit.config.sitemapUrl] : undefined,
    scope: audit.config.scope,
    auth,
  };
  const [row] = await db
    .insert(crawls)
    .values({
      id,
      workspace: ws,
      auditId: audit.id,
      siteOrigin,
      profile: audit.config.profile ?? "form",
      config,
      status: "queued",
      budget: audit.config.maxPages,
      maxDepth: audit.config.maxDepth,
    })
    .returning({ id: crawls.id });
  await enqueueCrawl(queue, row.id);
  const ref: CrawlerV2Ref = { version: 2, crawlId: row.id, status: "queued", states: {}, syncedAt: new Date().toISOString() };
  return store.update((d) => {
    const a = d.audits[audit.id];
    a.crawler = ref;
    return a;
  });
}

interface CrawlStatusRow {
  status: CrawlerV2Ref["status"];
  robots: { outcome?: string } | null;
  discovery_done: boolean;
  error: { code?: string; message?: string } | null;
  finished_at: string | null;
}

/** Read the crawl's status and URL counts from Postgres and mirror them onto the audit. */
export async function syncAudit(db: Db, store: Store, auditId: string): Promise<AuditRun> {
  const audit = (await store.read()).audits[auditId];
  if (!audit) throw new WorkflowError("NOT_FOUND", "Audit not found.");
  if (!audit.crawler) return audit;
  const crawlId = audit.crawler.crawlId;
  const r = await db.execute(sql`select status, robots, discovery_done, error, finished_at from crawls where id = ${crawlId}::uuid`);
  const row = r.rows[0] as unknown as CrawlStatusRow | undefined;
  if (!row) throw new WorkflowError("NOT_FOUND", "The crawl for this audit no longer exists.");
  const states = (await stateCounts(db, crawlId)) as Record<string, number>;
  const sum = (keys: string[]) => keys.reduce((n, k) => n + (states[k] ?? 0), 0);
  const total = Object.values(states).reduce((a, b) => a + b, 0);

  return store.update((d) => {
    const a = d.audits[auditId];
    if (!a?.crawler) throw new WorkflowError("NOT_FOUND", "Audit not found.");
    a.crawler = { ...a.crawler, status: row.status, states, syncedAt: new Date().toISOString() };
    a.progress = { ...a.progress, planned: total, done: total - sum(ACTIVE), inspected: sum(INSPECTED), failed: sum(FAILED), skipped: sum(SKIPPED) };
    a.heartbeatAt = new Date().toISOString();
    const finished: Partial<Record<CrawlerV2Ref["status"], AuditStatus>> = { completed: "completed", cancelled: "cancelled", failed: "failed" };
    const status = finished[row.status];
    if (status) {
      a.status = status;
      a.phase = "done";
      a.finishedAt = row.finished_at ? new Date(row.finished_at).toISOString() : new Date().toISOString();
      if (status === "failed") {
        // A failure the runner recorded on purpose carries its own code and message; anything else is an internal error.
        a.error = row.error?.code ? { code: row.error.code, message: row.error.message ?? row.error.code } : { code: "INTERNAL", message: `The crawl stopped with an error: ${row.error?.message ?? "unknown"}` };
      }
    } else {
      a.phase = !row.robots?.outcome ? "robots" : !row.discovery_done ? "sitemap" : "pages";
    }
    return a;
  });
}

/** Pause, resume or cancel through crawls.status; the worker acts on it before its next request. */
export async function controlCrawl(db: Db, queue: Queue<CrawlJob>, audit: AuditRun, action: "pause" | "resume" | "cancel"): Promise<void> {
  if (!audit.crawler) throw new WorkflowError("INVALID", "This audit was not run by crawler v2.");
  const id = audit.crawler.crawlId;
  const transitions = {
    pause: { from: ["queued", "running"], to: "paused" },
    resume: { from: ["paused"], to: "running" },
    cancel: { from: ["queued", "running", "paused"], to: "cancelling" },
  }[action];
  const r = await db.execute(sql`update crawls set status = ${transitions.to}
    where id = ${id}::uuid and status in (${sql.join(transitions.from.map((s) => sql`${s}`), sql`, `)}) returning id`);
  if (!r.rows.length) {
    const cur = (await db.execute(sql`select status from crawls where id = ${id}::uuid`)).rows[0] as { status: string } | undefined;
    if (action === "cancel" && cur && ["cancelling", "cancelled", "completed", "failed"].includes(cur.status)) return; // already ending
    throw new WorkflowError("CONFLICT", `Cannot ${action} a crawl that is ${cur?.status ?? "missing"}.`);
  }
  // Paused and queued crawls have no running job: resume and cancel need a worker to pick them up.
  if (action !== "pause") await enqueueCrawl(queue, id);
}

export async function deleteCrawlFor(db: Db, audit: AuditRun): Promise<void> {
  if (audit.crawler) await db.execute(sql`delete from crawls where id = ${audit.crawler.crawlId}::uuid`);
}
