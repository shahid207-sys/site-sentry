// Scheduled audits in Postgres: the schedules, their launches (schedule_runs) and the regression check of each
// launched audit (alert_deliveries). The scheduler claims due schedules with FOR UPDATE SKIP LOCKED and moves
// next_run_at in the same transaction, so two app instances never launch one schedule twice.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { nextRun, type Cadence, type ScheduleTiming } from "./cadence";

type Exec = Pick<Db, "execute">;

export interface ScheduleInput extends ScheduleTiming {
  /** Set by the caller when the webhook secret is encrypted with the id as its scope. */
  id?: string;
  workspace: string;
  siteId: string;
  /** The audit request (AuditRequest) to launch. */
  request: unknown;
  webhookUrl: string | null;
  /** Encrypted signing secret; required with a webhook URL. */
  webhookSecret: string | null;
}

/** A schedule as the API shows it: the signing secret never leaves the server. */
export interface Schedule {
  id: string;
  workspace: string;
  siteId: string;
  request: unknown;
  cadence: Cadence;
  hourUtc: number;
  weekday: number | null;
  monthday: number | null;
  webhookUrl: string | null;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt: string | null;
  createdAt: string;
  lastRun: { auditId: string | null; error: string | null; startedAt: string } | null;
}

export interface Delivery {
  id: number;
  crawlId: string;
  baseCrawlId: string | null;
  auditId: string | null;
  status: "sent" | "failed" | "skipped";
  httpStatus: number | null;
  attempts: number;
  detail: string;
  payload: unknown;
  createdAt: string;
}

const iso = (v: Date | string | null) => (v === null ? null : new Date(v).toISOString());

type Row = {
  id: string; workspace: string; site_id: string; request: unknown; cadence: Cadence; hour_utc: number; weekday: number | null; monthday: number | null;
  webhook_url: string | null; enabled: boolean; next_run_at: Date | string; last_run_at: Date | string | null; created_at: Date | string;
  run_audit: string | null; run_error: string | null; run_at: Date | string | null;
};

const toSchedule = (r: Row): Schedule => ({
  id: r.id,
  workspace: r.workspace,
  siteId: r.site_id,
  request: r.request,
  cadence: r.cadence,
  hourUtc: Number(r.hour_utc),
  weekday: r.weekday === null ? null : Number(r.weekday),
  monthday: r.monthday === null ? null : Number(r.monthday),
  webhookUrl: r.webhook_url,
  enabled: r.enabled,
  nextRunAt: iso(r.next_run_at)!,
  lastRunAt: iso(r.last_run_at),
  createdAt: iso(r.created_at)!,
  lastRun: r.run_at ? { auditId: r.run_audit, error: r.run_error, startedAt: iso(r.run_at)! } : null,
});

const SELECT = sql`select s.id, s.workspace, s.site_id, s.request, s.cadence, s.hour_utc, s.weekday, s.monthday, s.webhook_url, s.enabled,
    s.next_run_at, s.last_run_at, s.created_at, lr.audit_id as run_audit, lr.error as run_error, lr.started_at as run_at
  from audit_schedules s
  left join lateral (select audit_id, error, started_at from schedule_runs r where r.schedule_id = s.id order by r.id desc limit 1) lr on true`;

export async function insertSchedule(db: Exec, s: ScheduleInput, now: Date): Promise<Schedule> {
  const next = nextRun(s, now);
  const r = await db.execute(sql`insert into audit_schedules (id, workspace, site_id, request, cadence, hour_utc, weekday, monthday, webhook_url, webhook_secret, next_run_at)
    values (coalesce(${s.id ?? null}::uuid, gen_random_uuid()), ${s.workspace}, ${s.siteId}, ${JSON.stringify(s.request)}::jsonb, ${s.cadence}, ${s.hourUtc}, ${s.cadence === "weekly" ? s.weekday! : null},
      ${s.cadence === "monthly" ? s.monthday! : null}, ${s.webhookUrl}, ${s.webhookSecret}, ${next.toISOString()})
    returning id`);
  return (await getSchedule(db, s.workspace, (r.rows[0] as { id: string }).id))!;
}

export async function listSchedules(db: Exec, workspace: string, siteId?: string): Promise<Schedule[]> {
  const r = await db.execute(sql`${SELECT} where s.workspace = ${workspace} ${siteId ? sql`and s.site_id = ${siteId}` : sql``} order by s.created_at, s.id`);
  return (r.rows as Row[]).map(toSchedule);
}

export async function getSchedule(db: Exec, workspace: string, id: string): Promise<Schedule | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await db.execute(sql`${SELECT} where s.workspace = ${workspace} and s.id = ${id}::uuid`);
  const row = r.rows[0] as Row | undefined;
  return row ? toSchedule(row) : null;
}

/** The encrypted signing secret and webhook of a schedule (server only). */
export async function scheduleWebhook(db: Exec, id: string): Promise<{ url: string; secret: string } | null> {
  const r = await db.execute(sql`select webhook_url, webhook_secret from audit_schedules where id = ${id}::uuid`);
  const row = r.rows[0] as { webhook_url: string | null; webhook_secret: string | null } | undefined;
  return row?.webhook_url && row.webhook_secret ? { url: row.webhook_url, secret: row.webhook_secret } : null;
}

/** Pause or resume. Resuming moves the next run to the next slot after now (missed slots are not caught up). */
export async function setEnabled(db: Exec, workspace: string, id: string, enabled: boolean, now: Date): Promise<Schedule | null> {
  const s = await getSchedule(db, workspace, id);
  if (!s) return null;
  const next = enabled && !s.enabled ? nextRun(s, now).toISOString() : s.nextRunAt;
  await db.execute(sql`update audit_schedules set enabled = ${enabled}, next_run_at = ${next} where id = ${id}::uuid`);
  return getSchedule(db, workspace, id);
}

/** Run at the next scheduler tick; the regular cadence resumes after it. */
export async function runNow(db: Exec, workspace: string, id: string, now: Date): Promise<Schedule | null> {
  await db.execute(sql`update audit_schedules set next_run_at = ${now.toISOString()}, enabled = true where workspace = ${workspace} and id = ${id}::uuid`);
  return getSchedule(db, workspace, id);
}

export async function deleteSchedule(db: Exec, workspace: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  const r = await db.execute(sql`delete from audit_schedules where workspace = ${workspace} and id = ${id}::uuid returning id`);
  return r.rows.length > 0;
}

/** Every schedule of a site goes with it. */
export async function deleteSiteSchedules(db: Exec, workspace: string, siteId: string): Promise<void> {
  await db.execute(sql`delete from audit_schedules where workspace = ${workspace} and site_id = ${siteId}`);
}

export interface DueSchedule {
  id: string;
  workspace: string;
  siteId: string;
  request: unknown;
}

/** Claims up to `limit` due schedules and moves each one's next run past `now`, in one transaction. */
export async function claimDue(db: Db, now: Date, limit = 10): Promise<DueSchedule[]> {
  return db.transaction(async (tx) => {
    const r = await tx.execute(sql`select id, workspace, site_id, request, cadence, hour_utc, weekday, monthday from audit_schedules
      where enabled and next_run_at <= ${now.toISOString()} order by next_run_at, id limit ${limit} for update skip locked`);
    const rows = r.rows as Pick<Row, "id" | "workspace" | "site_id" | "request" | "cadence" | "hour_utc" | "weekday" | "monthday">[];
    for (const s of rows) {
      const next = nextRun({ cadence: s.cadence, hourUtc: Number(s.hour_utc), weekday: s.weekday, monthday: s.monthday }, now);
      await tx.execute(sql`update audit_schedules set next_run_at = ${next.toISOString()}, last_run_at = ${now.toISOString()} where id = ${s.id}::uuid`);
    }
    return rows.map((s) => ({ id: s.id, workspace: s.workspace, siteId: s.site_id, request: s.request }));
  });
}

export async function recordRun(db: Exec, scheduleId: string, workspace: string, outcome: { auditId: string } | { error: string }): Promise<void> {
  await db.execute(sql`insert into schedule_runs (schedule_id, workspace, audit_id, error)
    values (${scheduleId}::uuid, ${workspace}, ${"auditId" in outcome ? outcome.auditId : null}, ${"error" in outcome ? outcome.error.slice(0, 1000) : null})`);
}

/** The schedule that launched a crawl's audit, if any. */
export async function scheduleOfCrawl(db: Exec, crawlId: string): Promise<{ scheduleId: string; workspace: string; siteId: string; auditId: string } | null> {
  const r = await db.execute(sql`select r.schedule_id, r.workspace, s.site_id, r.audit_id from crawls c
    join schedule_runs r on r.workspace = c.workspace and r.audit_id = c.audit_id
    join audit_schedules s on s.id = r.schedule_id
    where c.id = ${crawlId}::uuid and c.kind = 'audit' limit 1`);
  const row = r.rows[0] as { schedule_id: string; workspace: string; site_id: string; audit_id: string } | undefined;
  return row ? { scheduleId: row.schedule_id, workspace: row.workspace, siteId: row.site_id, auditId: row.audit_id } : null;
}

export async function deliveryExists(db: Exec, scheduleId: string, crawlId: string): Promise<boolean> {
  const r = await db.execute(sql`select 1 from alert_deliveries where schedule_id = ${scheduleId}::uuid and crawl_id = ${crawlId}::uuid`);
  return r.rows.length > 0;
}

export async function recordDelivery(
  db: Exec,
  d: { scheduleId: string; crawlId: string; baseCrawlId: string | null; status: Delivery["status"]; httpStatus: number | null; attempts: number; detail: string; payload: unknown },
): Promise<void> {
  await db.execute(sql`insert into alert_deliveries (schedule_id, crawl_id, base_crawl_id, status, http_status, attempts, detail, payload)
    values (${d.scheduleId}::uuid, ${d.crawlId}::uuid, ${d.baseCrawlId}, ${d.status}, ${d.httpStatus}, ${d.attempts}, ${d.detail.slice(0, 1000)},
      ${d.payload === null ? null : JSON.stringify(d.payload)}::jsonb)
    on conflict (schedule_id, crawl_id) do nothing`);
}

export async function listDeliveries(db: Exec, workspace: string, scheduleId: string, limit = 50): Promise<Delivery[]> {
  const r = await db.execute(sql`select d.id, d.crawl_id, d.base_crawl_id, c.audit_id, d.status, d.http_status, d.attempts, d.detail, d.payload, d.created_at
    from alert_deliveries d join audit_schedules s on s.id = d.schedule_id left join crawls c on c.id = d.crawl_id
    where s.workspace = ${workspace} and d.schedule_id = ${scheduleId}::uuid order by d.id desc limit ${limit}`);
  return (r.rows as { id: number; crawl_id: string; base_crawl_id: string | null; audit_id: string | null; status: Delivery["status"]; http_status: number | null; attempts: number; detail: string; payload: unknown; created_at: Date | string }[]).map((x) => ({
    id: Number(x.id),
    crawlId: x.crawl_id,
    baseCrawlId: x.base_crawl_id,
    auditId: x.audit_id,
    status: x.status,
    httpStatus: x.http_status,
    attempts: x.attempts,
    detail: x.detail,
    payload: x.payload,
    createdAt: iso(x.created_at)!,
  }));
}
