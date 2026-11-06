// The shape of src/lib/sample/v2-sample.json, written by scripts/sample-v2.ts from a real crawler v2 audit.
import type { GroupChange, CrawlOverview } from "../results/queries";
import type { ReportGroup } from "../results/report";

export interface SampleV2Snapshot {
  generator: string;
  generatedAt: string;
  siteName: string;
  origin: string;
  /** The audit's overview, as the Overview screen gets it (crawlOverview). */
  overview: CrawlOverview;
  crawl: { budget: number | null; maxDepth: number | null; fetchesCommitted: number };
  /** Issue groups, highest priority score first, with the catalog title and explanation (reportData). URL lists trimmed to 20. */
  groups: ReportGroup[];
  rulesRan: number;
  /** Against the previous audit of the same site. */
  comparison: { totals: Record<GroupChange, number>; groups: { ruleId: string; change: GroupChange }[] } | null;
  /** Health per audit, oldest first. */
  history: { at: string; health: number | null }[];
}
