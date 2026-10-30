import "server-only";
import { getCrawlQueue } from "../crawl/v2/audit-bridge";
import { getDb } from "../db/client";
import type { Workspace } from "../model";
import { compareCrawls, crawlOverview, issueGroups, latestVerification, ResultsError, type Comparison, type CrawlOverview, type IssueGroupRow, type VerificationResult } from "../results/queries";
import { issueRows, pageDetail, urlRows, type IssueRow, type PageDetail, type UrlRow } from "../results/explore";
import { startVerification, type StartedVerification } from "../results/verify";
import { previousAudit } from "../results/states";
import { WorkflowError } from "../workflow/deps";
import { getStore } from "../workspace";

export async function crawlOf(ws: Workspace, auditId: string): Promise<{ crawlId: string; siteId: string }> {
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

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ResultsError) throw new WorkflowError(e.code, e.message);
    throw e;
  }
}

/** Re-crawl the URLs of one issue group of a v2 audit and update their states. */
export async function verifyIssueGroup(ws: Workspace, auditId: string, ruleId: string): Promise<StartedVerification> {
  const { crawlId } = await crawlOf(ws, auditId);
  return mapped(() => startVerification(getDb(), getCrawlQueue(), crawlId, ruleId));
}

/** The latest verification of one issue group of a v2 audit. */
export async function getGroupVerification(ws: Workspace, auditId: string, ruleId: string): Promise<VerificationResult | null> {
  const { crawlId } = await crawlOf(ws, auditId);
  return mapped(() => latestVerification(getDb(), crawlId, ruleId));
}

/** A v2 audit's overview: coverage, health, states, priorities (the numbers its report prints). */
export async function getAuditOverview(ws: Workspace, auditId: string): Promise<CrawlOverview> {
  const { crawlId } = await crawlOf(ws, auditId);
  const o = await mapped(() => crawlOverview(getDb(), crawlId));
  if (o.workspace !== ws) throw new WorkflowError("NOT_FOUND", "Audit not found.");
  return o;
}

/** A v2 audit's issue groups, highest priority first, with their priority inputs and states. */
export async function getAuditGroups(ws: Workspace, auditId: string): Promise<IssueGroupRow[]> {
  const { crawlId } = await getAuditOverview(ws, auditId);
  return mapped(() => issueGroups(getDb(), crawlId));
}

/** Every fingerprint of a v2 audit with its effective state, for the Issues explorer. */
export async function getAuditIssues(ws: Workspace, auditId: string): Promise<IssueRow[]> {
  const { crawlId } = await getAuditOverview(ws, auditId);
  return issueRows(getDb(), crawlId);
}

/** Every URL of a v2 audit with its page facts, for the URL explorer. */
export async function getAuditUrls(ws: Workspace, auditId: string): Promise<UrlRow[]> {
  const { crawlId } = await getAuditOverview(ws, auditId);
  return urlRows(getDb(), crawlId);
}

/** Everything a v2 audit knows about one of its URLs (normalised form), for the Page inspector. */
export async function getAuditPage(ws: Workspace, auditId: string, url: string): Promise<PageDetail> {
  const { crawlId } = await getAuditOverview(ws, auditId);
  const page = await pageDetail(getDb(), crawlId, url);
  if (!page) throw new WorkflowError("NOT_FOUND", "This audit has no such URL.");
  return page;
}
