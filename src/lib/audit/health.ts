import type { Severity } from "./types";

/** Points deducted per open issue type (one check failing on one site), by severity. */
export const HEALTH_WEIGHTS: Record<Severity, number> = { high: 10, medium: 3, low: 1 };

export const HEALTH_FORMULA = "100 − 10 per high, 3 per medium and 1 per low-severity open issue type (minimum 0)";

export const HEALTH_NOTE =
  "A SiteSentry triage indicator, not a search-engine metric. Issues are counted per check, not per page, so one template bug is one deduction.";

export type HealthBand = "good" | "fair" | "poor";

/**
 * Health score for a site from its open issue types by severity. Counted per issue type so the
 * score tracks how many distinct fixes are outstanding, the same unit the issue list shows.
 */
export function healthScore(openTypes: Record<Severity, number>): number {
  const penalty = openTypes.high * HEALTH_WEIGHTS.high + openTypes.medium * HEALTH_WEIGHTS.medium + openTypes.low * HEALTH_WEIGHTS.low;
  return Math.max(0, 100 - penalty);
}

export function healthBand(score: number): HealthBand {
  return score >= 80 ? "good" : score >= 60 ? "fair" : "poor";
}

export const HEALTH_LABEL: Record<HealthBand, string> = { good: "Good", fair: "Needs work", poor: "Poor" };

/** Counts distinct issue types (rule codes) by their worst severity. */
export function countIssueTypes(findings: { ruleCode: string; priority: { severity: Severity } }[]): Record<Severity, number> {
  const worst = new Map<string, Severity>();
  const rank: Record<Severity, number> = { high: 3, medium: 2, low: 1 };
  for (const f of findings) {
    const prev = worst.get(f.ruleCode);
    if (!prev || rank[f.priority.severity] > rank[prev]) worst.set(f.ruleCode, f.priority.severity);
  }
  const out: Record<Severity, number> = { high: 0, medium: 0, low: 0 };
  for (const s of worst.values()) out[s]++;
  return out;
}
