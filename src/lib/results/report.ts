// The report's data (docs/SPEC.md "Reporting"): one object built from the same queries as the API (queries.ts), so
// every number in the HTML, the PDF and a share link is the number the API returns. The renderer
// (src/lib/report/html.ts) only formats this object.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { Branding } from "../model";
import { RULES } from "../rules/registry";
import { RULE_TITLES } from "../rules/titles";
import {
  affectedUrlList,
  compareCrawls,
  crawlOverview,
  depthHistogram,
  duplicateClusters,
  groupEvidence,
  issueGroups,
  ruleRunList,
  type Comparison,
  type CrawlOverview,
  type DuplicateCluster,
  type EvidenceSample,
  type IssueGroupRow,
  type RuleRunRow,
} from "./queries";
import { previousAudit } from "./states";
import { notVerifiable } from "./verify";

type Exec = Pick<Db, "execute">;

/** URLs listed in the report per group; a longer list is linked as CSV. */
export const INLINE_URLS = 50;
/** Priority issue pages: every group above info, highest score first, at most this many (the rest are in the category sections). */
export const PRIORITY_PAGES = 25;

export interface ReportGroup extends IssueGroupRow {
  title: string;
  why: string;
  fix: string;
  acceptance: string;
  docs?: string;
  evidence: EvidenceSample[];
  /** The first INLINE_URLS affected URLs; `affectedUrls` is the full count. */
  urls: { url: string; state: string }[];
  /** Whether a fix verification can re-check this group (verify.ts notVerifiable). */
  verifiable: boolean;
}

export interface ReportData {
  generatedAt: string;
  overview: CrawlOverview;
  crawl: { budget: number | null; maxDepth: number | null; fetchesCommitted: number; robots: { url?: string; status?: number | null; outcome?: string; reason?: string } | null; resources: Record<string, unknown> | null };
  /** Against the previous analysed audit of the project; null when this is the first. */
  comparison: Comparison | null;
  groups: ReportGroup[];
  ruleRuns: (RuleRunRow & { title: string })[];
  depth: { depth: number | null; urls: number; answered: number }[];
  duplicates: DuplicateCluster[];
  branding: Branding;
}

export async function reportData(db: Exec, crawlId: string, branding: Branding = {}): Promise<ReportData> {
  const overview = await crawlOverview(db, crawlId);
  const c = (await db.execute(sql`select budget, max_depth, fetches_committed, robots, resources from crawls where id = ${crawlId}::uuid`)).rows[0] as {
    budget: number | null;
    max_depth: number | null;
    fetches_committed: number;
    robots: ReportData["crawl"]["robots"];
    resources: Record<string, unknown> | null;
  };
  const base = await previousAudit(db, crawlId);
  const groupRows = await issueGroups(db, crawlId);
  const evidence = await groupEvidence(db, crawlId, groupRows.map((g) => g.ruleId));
  const byId = new Map(RULES.map((r) => [r.id, r]));
  const groups: ReportGroup[] = [];
  for (const g of groupRows) {
    const rule = byId.get(g.ruleId);
    groups.push({
      ...g,
      title: RULE_TITLES[g.ruleId] ?? g.ruleId,
      why: rule?.explain.why ?? "",
      fix: rule?.explain.fix ?? "",
      acceptance: rule?.explain.acceptance ?? "",
      docs: rule?.explain.docs,
      evidence: evidence.get(g.ruleId) ?? [],
      urls: await affectedUrlList(db, crawlId, g.ruleId, INLINE_URLS),
      verifiable: notVerifiable(g.ruleId) === null,
    });
  }
  return {
    generatedAt: new Date().toISOString(),
    overview,
    crawl: { budget: c.budget, maxDepth: c.max_depth, fetchesCommitted: Number(c.fetches_committed), robots: c.robots, resources: c.resources },
    comparison: base ? await compareCrawls(db, base, crawlId) : null,
    groups,
    ruleRuns: (await ruleRunList(db, crawlId)).map((r) => ({ ...r, title: RULE_TITLES[r.ruleId] ?? r.ruleId })),
    depth: await depthHistogram(db, crawlId),
    duplicates: await duplicateClusters(db, crawlId),
    branding,
  };
}
