import "server-only";
// Scheduled audits for the API and the in-process scheduler (src/instrumentation.ts). A schedule stores an audit
// request; at each due time the scheduler launches it like the New audit form does, and the analysis worker compares
// the result with the site's previous audit and posts a signed alert when something regressed (lib/schedule/deliver).
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { AuditRequest, checkAuditRequest, launchAudit } from "@/app/api/_lib/audits";
import { crawlerV2Enabled } from "../crawl/v2/flag";
import { encryptSecret, secretKey } from "../crawl/v2/secrets";
import { getDb } from "../db/client";
import { SafeFetchError, validateTargetUrl } from "../fetch/safe-fetch";
import type { Workspace } from "../model";
import { CADENCES, timingProblem } from "../schedule/cadence";
import { webhookScope } from "../schedule/deliver";
import { claimDue, deleteSchedule, deleteSiteSchedules, getSchedule, insertSchedule, listDeliveries, listSchedules, recordRun, runNow, setEnabled, type Delivery, type Schedule } from "../schedule/store";
import { WorkflowError } from "../workflow/deps";
import { assertLiveScans, getStore, isWorkspace } from "../workspace";

/** The audit a schedule runs: the New audit request without the site (the schedule's) and without basic auth. */
const ScheduledRequest = AuditRequest.omit({ siteId: true, auth: true });

export const ScheduleBody = z.object({
  siteId: z.string().min(1).max(80),
  cadence: z.enum(CADENCES),
  hourUtc: z.number().int(),
  weekday: z.number().int().nullable().optional(),
  monthday: z.number().int().nullable().optional(),
  request: ScheduledRequest,
  webhookUrl: z.string().max(2000).nullable().optional(),
});
export type ScheduleBody = z.infer<typeof ScheduleBody>;

function assertSchedulable(ws: Workspace) {
  if (ws === "sample") throw new WorkflowError("READ_ONLY", "The sample workspace cannot schedule audits. Open your own workspace.");
  // Alerts compare v2 audits (issue states per fingerprint); the legacy engine has none.
  if (!crawlerV2Enabled(ws)) throw new WorkflowError("INVALID", "Scheduled audits need crawler v2, which is off on this server (CRAWLER_V2).");
}

export async function listSiteSchedules(ws: Workspace, siteId?: string): Promise<Schedule[]> {
  if (!crawlerV2Enabled(ws)) return [];
  return listSchedules(getDb(), ws, siteId);
}

/** Creates a schedule. A webhook gets a new signing secret, returned here once and stored encrypted. */
export async function createSchedule(ws: Workspace, input: ScheduleBody, now = new Date()): Promise<{ schedule: Schedule; webhookSecret: string | null }> {
  assertSchedulable(ws);
  assertLiveScans(ws);
  const site = (await getStore(ws).read()).sites[input.siteId];
  if (!site) throw new WorkflowError("NOT_FOUND", "Site not found.");
  const timing = { cadence: input.cadence, hourUtc: input.hourUtc, weekday: input.weekday ?? null, monthday: input.monthday ?? null };
  const problem = timingProblem(timing);
  if (problem) throw new WorkflowError("INVALID", problem);
  checkAuditRequest(ws, { ...input.request, siteId: input.siteId });

  const id = randomUUID();
  let webhookUrl: string | null = null;
  let secret: string | null = null;
  let encrypted: string | null = null;
  if (input.webhookUrl?.trim()) {
    try {
      webhookUrl = validateTargetUrl(input.webhookUrl).toString();
    } catch (e) {
      throw new WorkflowError("INVALID", `Webhook URL: ${e instanceof SafeFetchError ? e.message : "not a valid URL."}`);
    }
    const key = secretKey();
    if (!key) throw new WorkflowError("INVALID", "A webhook needs CRAWLER_SECRET_KEY set on the server, so its signing secret can be stored encrypted.");
    secret = randomBytes(32).toString("base64url");
    encrypted = encryptSecret(secret, key, webhookScope(id));
  }
  const schedule = await insertSchedule(getDb(), { id, workspace: ws, siteId: input.siteId, request: input.request, ...timing, webhookUrl, webhookSecret: encrypted }, now);
  return { schedule, webhookSecret: secret };
}

export const SchedulePatch = z.object({ enabled: z.boolean().optional(), runNow: z.literal(true).optional() });

export async function updateSchedule(ws: Workspace, id: string, patch: z.infer<typeof SchedulePatch>, now = new Date()): Promise<Schedule> {
  assertSchedulable(ws);
  const db = getDb();
  let s = await getSchedule(db, ws, id);
  if (!s) throw new WorkflowError("NOT_FOUND", "Schedule not found.");
  if (patch.enabled !== undefined) s = await setEnabled(db, ws, id, patch.enabled, now);
  if (patch.runNow) s = await runNow(db, ws, id, now);
  return s!;
}

export async function removeSchedule(ws: Workspace, id: string): Promise<{ deleted: true }> {
  assertSchedulable(ws);
  if (!(await deleteSchedule(getDb(), ws, id))) throw new WorkflowError("NOT_FOUND", "Schedule not found.");
  return { deleted: true };
}

export async function scheduleDeliveries(ws: Workspace, id: string): Promise<Delivery[]> {
  assertSchedulable(ws);
  if (!(await getSchedule(getDb(), ws, id))) throw new WorkflowError("NOT_FOUND", "Schedule not found.");
  return listDeliveries(getDb(), ws, id);
}

/** A deleted site's schedules go with it (their runs and deliveries cascade). */
export async function deleteSiteSchedulesOf(ws: Workspace, siteId: string): Promise<void> {
  if (crawlerV2Enabled(ws)) await deleteSiteSchedules(getDb(), ws, siteId);
}

export interface TickResult {
  launched: { scheduleId: string; auditId: string }[];
  failed: { scheduleId: string; error: string }[];
}

/**
 * Launches every due schedule once. Claiming moves each schedule's next run past `now` in the same transaction, so
 * concurrent ticks (two app instances) never launch one slot twice; a failed launch is recorded, not retried.
 */
export async function runDueSchedules(now = new Date()): Promise<TickResult> {
  const db = getDb();
  const out: TickResult = { launched: [], failed: [] };
  for (const due of await claimDue(db, now)) {
    try {
      if (!isWorkspace(due.workspace)) throw new Error(`Unknown workspace "${due.workspace}".`);
      const ws = due.workspace;
      assertLiveScans(ws);
      if (!(await getStore(ws).read()).sites[due.siteId]) throw new WorkflowError("NOT_FOUND", "The schedule's site no longer exists.");
      const request = AuditRequest.parse({ ...(due.request as object), siteId: due.siteId });
      const { audit, reused } = await launchAudit(ws, request);
      // Never adopt an audit someone else started: its alert would be sent as this schedule's.
      if (reused) throw new WorkflowError("BUSY", "The site already had an audit running, so this slot was skipped.");
      await recordRun(db, due.id, ws, { auditId: audit.id });
      out.launched.push({ scheduleId: due.id, auditId: audit.id });
    } catch (e) {
      const error = (e as Error).message || "The audit could not be started.";
      await recordRun(db, due.id, due.workspace, { error });
      out.failed.push({ scheduleId: due.id, error });
    }
  }
  return out;
}
