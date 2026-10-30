// Pure numbers of the audit Overview (no React): the coverage funnel and its gaps, the health score's decomposition
// per category, and the change totals vs the previous audit. Every figure is derived from the API's own fields.
import type { Coverage } from "@/lib/results/coverage";
import type { Health } from "@/lib/results/health";
import type { CrawlOverview, GroupChange } from "@/lib/results/queries";

// Copies of the state lists in src/lib/results/coverage.ts (that module imports drizzle, so the browser cannot load
// it). Keep them in step with the source.
export const ANSWERED = ["fetched", "analysed", "redirected", "non_html", "oversized"];
export const NOT_OURS = ["blocked_robots", "excluded_by_rule", "cdn_managed"];
export const UNFETCHED = ["budget_exhausted", "depth_exceeded", "cancelled", "interrupted", "failed_timeout", "failed_network", "failed_dns", "failed_tls"];

export interface FunnelStep {
  id: "discovered" | "eligible" | "answered" | "indexable";
  label: string;
  value: number;
  /** Share of the first step (discovered), 0–100; null when nothing was discovered. */
  ofTotal: number | null;
  /** Share of the step before, 0–100, one decimal; null for the first step or a zero step before. */
  ofPrevious: number | null;
  hint: string;
}

const pct = (n: number, d: number) => (d > 0 ? Math.round((1000 * n) / d) / 10 : null);

/**
 * Discovered → in scope → answered (→ indexable, when known). `indexable` is the crawl-wide count of indexable pages
 * the issue groups were scored against (IssueGroupRow.indexablePages); pass null when the audit has no group.
 */
export function funnel(c: Coverage, indexable: number | null): FunnelStep[] {
  const steps: Omit<FunnelStep, "ofTotal" | "ofPrevious">[] = [
    { id: "discovered", label: "Discovered", value: c.total, hint: "Every URL the crawl found, on any host" },
    { id: "eligible", label: "In scope", value: c.eligible, hint: "Discovered, minus what robots.txt, your scope rules or the CDN rule out" },
    { id: "answered", label: "Crawled", value: c.answered, hint: "Requested and answered (pages, redirects, non-HTML files)" },
  ];
  if (indexable !== null) steps.push({ id: "indexable", label: "Indexable", value: indexable, hint: "Crawled HTML pages search engines may index: the base of every reach figure" });
  return steps.map((s, i) => ({ ...s, ofTotal: pct(s.value, c.total), ofPrevious: i === 0 ? null : pct(s.value, steps[i - 1].value) }));
}

export interface CoverageGap {
  state: string;
  n: number;
  /** excluded: the site or the audit's own rules ruled it out; missed: in scope but not answered. */
  kind: "excluded" | "missed";
}

/** URL states that are not answered, largest first (what explains the drops in the funnel). */
export function coverageGaps(c: Coverage, limit = 6): CoverageGap[] {
  return Object.entries(c.states)
    .filter(([s, n]) => n > 0 && !ANSWERED.includes(s))
    .map(([state, n]) => ({ state, n, kind: (NOT_OURS.includes(state) ? "excluded" : "missed") as CoverageGap["kind"] }))
    .sort((a, b) => b.n - a.n || (a.state < b.state ? -1 : 1))
    .slice(0, limit);
}

export interface CategoryPart {
  category: string;
  weight: number;
  score: number;
  rulesRan: number;
  /** This category's share of the overall score, in points: weight × score / Σ weights (one decimal). */
  points: number;
  /** The most points it could give: weight / Σ weights × 100 (one decimal). */
  maxPoints: number;
}

/**
 * The health score as a sum of per-category points over the categories with a rule that ran (docs/HEALTH-SCORE.md:
 * a weighted mean, so each category gives weight × score / Σ weights). Heaviest category first.
 */
export function decomposition(h: Health): CategoryPart[] {
  const entries = Object.entries(h.categories).filter((e): e is [string, NonNullable<(typeof e)[1]>] => !!e[1]);
  const total = entries.reduce((n, [, c]) => n + c.weight, 0);
  if (!total) return [];
  return entries
    .map(([category, c]) => ({
      category,
      weight: c.weight,
      score: c.score,
      rulesRan: c.rulesRan,
      points: Math.round((10 * c.weight * c.score) / total) / 10,
      maxPoints: Math.round((1000 * c.weight) / total) / 10,
    }))
    .sort((a, b) => b.weight - a.weight || (a.category < b.category ? -1 : 1));
}

/** Change kinds in the order the Overview lists them: what got worse first. */
export const CHANGE_ORDER: GroupChange[] = ["regressed", "new", "persistent", "not_rechecked", "resolved"];

export function changeRows(totals: Record<GroupChange, number>): { change: GroupChange; n: number }[] {
  return CHANGE_ORDER.map((change) => ({ change, n: totals[change] ?? 0 }));
}

/**
 * What to say when an analysed audit has no issue group, without claiming more than was checked: no rule ran, or
 * nothing was crawled, means no findings, not a clean site; partial coverage qualifies a clean result.
 */
export function noIssuesCopy(o: Pick<CrawlOverview, "rulesRan" | "coverage" | "health">): { title: string; body: string } {
  if (o.coverage.answered === 0)
    return { title: "Nothing was crawled", body: "No URL of the site was answered, so no rule had a page to check. That does not mean the site has no issues." };
  if (o.rulesRan === 0)
    return { title: "No rule ran", body: "No rule ran in this audit's analysis (rules may need configuration, or failed), so it has no findings. That does not mean the site has no issues." };
  const ran = `${o.rulesRan.toLocaleString("en-GB")} ${o.rulesRan === 1 ? "rule" : "rules"} ran over ${o.coverage.answered.toLocaleString("en-GB")} crawled ${o.coverage.answered === 1 ? "URL" : "URLs"} and none found an issue.`;
  return {
    title: "This audit found no issues",
    body: o.health?.partialCoverage ? `${ran} Coverage was partial, so this covers only the crawled part of the site.` : ran,
  };
}
