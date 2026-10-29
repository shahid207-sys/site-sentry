import "server-only";
import { getDb } from "../db/client";
import type { Workspace } from "../model";
import { compareCrawls, ResultsError, type Comparison } from "../results/queries";
import { previousAudit } from "../results/states";
import { WorkflowError } from "../workflow/deps";
import { getStore } from "../workspace";

async function crawlOf(ws: Workspace, auditId: string): Promise<{ crawlId: string; siteId: string }> {
  const a = (await getStore(ws).read()).audits[auditId];
  if (!a) throw new WorkflowError("NOT_FOUND", "Audit not found.");
  if (!a.crawler) throw new WorkflowError("INVALID", "This audit ran on the legacy engine: compare it with /compare.");
  return { crawlId: a.crawler.crawlId, siteId: a.siteId };
}

/** New, persistent, resolved, regressed and not re-checked issue groups between two v2 audits of one project. */
export async function getGroupComparison(ws: Workspace, headAuditId: string, baseAuditId?: string): Promise<Comparison> {
  const db = getDb();
  const head = await crawlOf(ws, headAuditId);
  let baseCrawl: string | null;
  if (baseAuditId) {
    const base = await crawlOf(ws, baseAuditId);
    if (base.siteId !== head.siteId) throw new WorkflowError("INVALID", "Both audits must belong to the same site.");
    baseCrawl = base.crawlId;
  } else {
    baseCrawl = await previousAudit(db, head.crawlId);
    if (!baseCrawl) throw new WorkflowError("NOT_FOUND", "This site has no earlier analysed audit to compare with yet.");
  }
  try {
    const c = await compareCrawls(db, baseCrawl, head.crawlId);
    if (c.head.workspace !== ws) throw new WorkflowError("NOT_FOUND", "Audit not found.");
    return c;
  } catch (e) {
    if (e instanceof ResultsError) throw new WorkflowError(e.code, e.message);
    throw e;
  }
}
