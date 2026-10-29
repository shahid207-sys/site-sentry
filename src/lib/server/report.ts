import "server-only";
import { getDb } from "../db/client";
import type { Workspace } from "../model";
import { groupUrlsCsv } from "../report/csv";
import { renderReport, REPORT_CSP } from "../report/html";
import { reportData, type ReportData } from "../results/report";
import { ResultsError } from "../results/queries";
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
