// Priority model (docs/SPEC.md "Rule engine and rule catalog"; formula published in docs/HEALTH-SCORE.md):
// score = Impact (1–5) × Reach (0–1) × Confidence weight. Pure: the analysis job stores all three inputs and the
// score on each issue group, and everything that shows a priority reads them from there.
import type { Confidence } from "../rules/contract";

export const CONFIDENCE_WEIGHT: Record<Confidence, number> = { verified: 1, heuristic: 0.6, advisory: 0.3 };

export type Priority = "critical" | "high" | "medium" | "low" | "info";

/** Lower bound of each band, highest first. A score below the last bound is info. */
export const PRIORITY_BANDS: { priority: Exclude<Priority, "info">; min: number }[] = [
  { priority: "critical", min: 3.5 },
  { priority: "high", min: 2.5 },
  { priority: "medium", min: 1.5 },
  { priority: "low", min: 0.5 },
];

/**
 * Reach: the log-scaled share of indexable pages affected, ln(1 + affected) / ln(1 + indexable), clamped to [0, 1].
 * One page of a thousand gives 0.10, ten 0.35, a hundred 0.67, all of them 1. No indexable page: 0.
 */
export function reach(affected: number, indexable: number): number {
  if (indexable <= 0 || affected <= 0) return 0;
  return Math.min(1, Math.log1p(Math.min(affected, indexable)) / Math.log1p(indexable));
}

export const round = (n: number, places = 4) => Math.round(n * 10 ** places) / 10 ** places;

export function priorityScore(impact: number, reachValue: number, confidence: Confidence): number {
  return round(impact * reachValue * CONFIDENCE_WEIGHT[confidence]);
}

export function priorityOf(score: number): Priority {
  return PRIORITY_BANDS.find((b) => score >= b.min)?.priority ?? "info";
}
