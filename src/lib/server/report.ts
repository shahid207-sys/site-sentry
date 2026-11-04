import "server-only";
import { createAiQueue, enqueueAi } from "../ai/queue";
import { readAiAnalysis } from "../ai/run";
import type { StoredAiAnalysis } from "../ai/schema";
import { getDb } from "../db/client";
import type { Workspace } from "../model";
import { groupUrlsCsv } from "../report/csv";
import { renderReport, REPORT_CSP } from "../report/html";
import { createShare, listShares, revokeShare, serveShare, type CreatedShare, type ShareInfo, type ShareRequest, type ShareResponse } from "../report/shares";
import { reportData, type ReportData } from "../results/report";
import { crawlOverview, ResultsError } from "../results/queries";
import { WorkflowError } from "../workflow/deps";
import { getStore } from "../workspace";
import { crawlOf } from "./results";

/** Headers for every report response (live and shared): nothing loads, nothing is indexed or cached by others. */
export const REPORT_HEADERS = {
  "content-security-policy": REPORT_CSP,
  "x-robots-tag": "noindex, nofollow, noarchive",
  "referrer-policy": "no-referrer",
  "cache-control": "private, no-store",
};

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ResultsError) throw new WorkflowError(e.code, e.message);
    throw e;
  }
}

/** The report's data for a v2 audit, with its site's white-label. The same object the HTML and PDF print. */
export async function getAuditReport(ws: Workspace, auditId: string): Promise<ReportData> {
  const { crawlId, siteId } = await crawlOf(ws, auditId);
  const site = (await getStore(ws).read()).sites[siteId];
  const data = await mapped(() => reportData(getDb(), crawlId, site?.branding ?? {}));
  if (data.overview.workspace !== ws) throw new WorkflowError("NOT_FOUND", "Audit not found.");
  if (!data.overview.analysed) throw new WorkflowError("INVALID", "The audit is not analysed yet: its report is available once the analysis finishes.");
  return data;
}

export async function getAuditReportHtml(ws: Workspace, auditId: string, csvHref: (ruleId: string) => string): Promise<string> {
  return renderReport(await getAuditReport(ws, auditId), { csvHref });
}

export async function getGroupUrlsCsv(ws: Workspace, auditId: string, ruleId: string): Promise<string> {
  const { crawlId } = await crawlOf(ws, auditId);
  await getAuditReport(ws, auditId);
  return groupUrlsCsv(getDb(), crawlId, ruleId);
}

// ---------- AI analysis ----------

/** The audit's AI analysis row, and whether its project has the setting on. */
export async function getAuditAi(ws: Workspace, auditId: string): Promise<{ enabled: boolean; ai: StoredAiAnalysis | null }> {
  const { siteId } = await crawlOf(ws, auditId);
  const site = (await getStore(ws).read()).sites[siteId];
  return { enabled: site?.aiAnalysis === true, ai: await readAiAnalysis(getDb(), auditId) };
}

const g = globalThis as unknown as { __ssAiQueue?: ReturnType<typeof createAiQueue> };

/** Queues the job for an audit that has finished its analysis. A finished analysis is the cache: nothing runs again. */
export async function requestAuditAi(ws: Workspace, auditId: string): Promise<{ enabled: boolean; ai: StoredAiAnalysis | null }> {
  const { crawlId, siteId } = await crawlOf(ws, auditId);
  const site = (await getStore(ws).read()).sites[siteId];
  if (site?.aiAnalysis !== true) throw new WorkflowError("INVALID", "AI analysis is off for this site: turn it on under Edit site first.");
  const data = await mapped(() => crawlOverview(getDb(), crawlId));
  if (!data.analysed) throw new WorkflowError("INVALID", "The audit is not analysed yet.");
  g.__ssAiQueue ??= createAiQueue();
  await enqueueAi(getDb(), g.__ssAiQueue, crawlId, auditId);
  return getAuditAi(ws, auditId);
}

// ---------- share links ----------

/** The white-label of the site an audit belongs to. */
async function brandingOf(ws: string, auditId: string) {
  const d = await getStore(ws as Workspace).read();
  const a = d.audits[auditId];
  return (a && d.sites[a.siteId]?.branding) || {};
}

export async function createAuditShare(ws: Workspace, auditId: string, o: { password?: string | null; expiresInDays?: number | null }): Promise<CreatedShare> {
  const { crawlId } = await crawlOf(ws, auditId);
  return mapped(() => createShare(getDb(), { workspace: ws, auditId, crawlId, ...o }));
}

export async function listAuditShares(ws: Workspace, auditId: string): Promise<ShareInfo[]> {
  await crawlOf(ws, auditId);
  return listShares(getDb(), ws, auditId);
}

export async function revokeAuditShare(ws: Workspace, auditId: string, shareId: string): Promise<{ revoked: true }> {
  if (!/^[0-9a-f-]{36}$/i.test(shareId) || !(await revokeShare(getDb(), ws, auditId, shareId))) throw new WorkflowError("NOT_FOUND", "Share link not found.");
  return { revoked: true };
}

/** One request to a public share link. */
export function answerShare(token: string, req: ShareRequest): Promise<ShareResponse> {
  return serveShare(getDb(), token, req, (ws, auditId) => brandingOf(ws, auditId));
}
