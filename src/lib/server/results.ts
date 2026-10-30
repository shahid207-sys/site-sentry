import "server-only";
import { sql } from "drizzle-orm";
import { getCrawlQueue } from "../crawl/v2/audit-bridge";
import { getDb } from "../db/client";
import type { Workspace } from "../model";
import { compareCrawls, crawlOverview, depthHistogram, duplicateClusters, issueGroups, latestVerification, ResultsError, type Comparison, type CrawlOverview, type DuplicateCluster, type IssueGroupRow, type VerificationResult } from "../results/queries";
import { issueRows, pageDetail, urlRows, type IssueRow, type PageDetail, type UrlRow } from "../results/explore";
import { auditTriage, fixBoard, setTriage, triageLog, type BoardCard, type TriageChange, type TriageEntry, type TriageEvent } from "../results/triage";
import { startVerification, type StartedVerification } from "../results/verify";
import { pageRender, type PageRenderDetail } from "../results/render";
import { previousAudit } from "../results/states";
import { blobStoreFromEnv } from "../snapshot/blob-store";
import { RULES } from "../rules/registry";
import { RULE_TITLES } from "../rules/titles";
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
  const crawlId = await auditCrawl(ws, auditId);
  return mapped(() => issueGroups(getDb(), crawlId));
}

/** The audit crawl behind a v2 audit of this workspace, without the overview's counts (row-level reads call it per request). */
async function auditCrawl(ws: Workspace, auditId: string): Promise<string> {
  const { crawlId } = await crawlOf(ws, auditId);
  const r = await getDb().execute(sql`select workspace, kind from crawls where id = ${crawlId}::uuid`);
  const c = r.rows[0] as { workspace: string; kind: string } | undefined;
  if (!c || c.workspace !== ws || c.kind !== "audit") throw new WorkflowError("NOT_FOUND", "Audit not found.");
  return crawlId;
}

/** Every fingerprint of a v2 audit with its effective state, for the Issues explorer (one rule's, with messages, when given). */
export async function getAuditIssues(ws: Workspace, auditId: string, ruleId?: string): Promise<IssueRow[]> {
  const crawlId = await auditCrawl(ws, auditId);
  return issueRows(getDb(), crawlId, ruleId);
}

/** Every URL of a v2 audit with its page facts, for the URL explorer. */
export async function getAuditUrls(ws: Workspace, auditId: string): Promise<UrlRow[]> {
  const crawlId = await auditCrawl(ws, auditId);
  return urlRows(getDb(), crawlId);
}

/** Everything a v2 audit knows about one of its URLs (normalised form), for the Page inspector. */
export async function getAuditPage(ws: Workspace, auditId: string, url: string): Promise<PageDetail> {
  const crawlId = await auditCrawl(ws, auditId);
  const page = await pageDetail(getDb(), crawlId, url);
  if (!page) throw new WorkflowError("NOT_FOUND", "This audit has no such URL.");
  return page;
}

/** One URL's render (raw vs rendered, lab metrics, requests, axe-core); `html` adds both documents for the diff. */
export async function getAuditPageRender(ws: Workspace, auditId: string, url: string, html: boolean): Promise<PageRenderDetail> {
  const crawlId = await auditCrawl(ws, auditId);
  const r = await pageRender(getDb(), blobStoreFromEnv(), crawlId, url, { html });
  if (!r) throw new WorkflowError("NOT_FOUND", "This audit has no such URL.");
  return r;
}

export interface CatalogRule {
  id: string;
  title: string;
  category: string;
  scope: string;
  impact: number;
  confidence: string;
  why: string;
  fix: string;
  acceptance: string;
  docs: string | null;
}

/** The implemented rules as the app explains them (Issues drawer, Fix board, ⌘K). */
export async function ruleCatalog(): Promise<CatalogRule[]> {
  return RULES.map((r) => ({
    id: r.id,
    title: RULE_TITLES[r.id] ?? r.id,
    category: r.category,
    scope: r.scope,
    impact: r.impact,
    confidence: r.confidence,
    why: r.explain.why,
    fix: r.explain.fix,
    acceptance: r.explain.acceptance,
    docs: r.explain.docs ?? null,
  }));
}

export interface AuditStructure {
  /** URLs per link depth from the seeds (null: only sitemaps found them) and how many were answered. */
  depth: { depth: number | null; urls: number; answered: number }[];
  /** Exact and near-duplicate clusters from the duplicate rules' findings. */
  duplicates: DuplicateCluster[];
}

/** A v2 audit's crawl depth histogram and duplicate clusters, for the Architecture and Content screens. */
export async function getAuditStructure(ws: Workspace, auditId: string): Promise<AuditStructure> {
  const crawlId = await auditCrawl(ws, auditId);
  const db = getDb();
  return { depth: await depthHistogram(db, crawlId), duplicates: await duplicateClusters(db, crawlId) };
}

/** Who a triage change is logged as: the app has no user accounts yet (Phase 6 collaboration), so one local user. */
export const LOCAL_ACTOR = "local user";

export interface AuditTriage {
  entries: TriageEntry[];
  board: BoardCard[];
}

/** A v2 audit's triage: board columns per issue group and per-issue calls (fixed, ignored with a reason). */
export async function getAuditTriage(ws: Workspace, auditId: string): Promise<AuditTriage> {
  const crawlId = await auditCrawl(ws, auditId);
  return mapped(async () => ({ entries: await auditTriage(getDb(), crawlId), board: await fixBoard(getDb(), crawlId) }));
}

/** Set the triage of issue groups ("rule:<id>") or issues ("fp:<fingerprint>") of a v2 audit. */
export async function updateAuditTriage(ws: Workspace, auditId: string, subjects: string[], change: TriageChange): Promise<TriageEntry[]> {
  const crawlId = await auditCrawl(ws, auditId);
  return mapped(() => setTriage(getDb(), crawlId, subjects, change, LOCAL_ACTOR));
}

/** The triage audit log of a v2 audit's project, or of one subject. */
export async function getTriageLog(ws: Workspace, auditId: string, subject?: string): Promise<TriageEvent[]> {
  const crawlId = await auditCrawl(ws, auditId);
  return mapped(() => triageLog(getDb(), crawlId, subject));
}
