import { describe, expect, it } from "vitest";
import { CATEGORY_WEIGHTS, healthScore, type RuleResult } from "./health";

const r = (ruleId: string, category: RuleResult["category"], impact: number, confidence: RuleResult["confidence"], score: number): RuleResult => ({ ruleId, category, impact, confidence, score });

describe("health score", () => {
  it("publishes weights that sum to 100", () => {
    expect(Object.values(CATEGORY_WEIGHTS).reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("scores each category over the rules that ran and averages by weight (hand-computed)", () => {
    const h = healthScore(
      [
        // indexability: maximum 5×1 + 4×0.6 = 7.4; deduction 2.5 + 0 → 100 × (1 − 2.5/7.4) = 66.2
        r("IDX-1", "indexability", 5, "verified", 2.5),
        r("IDX-2", "indexability", 4, "heuristic", 0),
        // metadata: maximum 3×0.3 = 0.9; deduction 0.45 → 50
        r("META-1", "metadata", 3, "advisory", 0.45),
        // links: clean → 100
        r("LNK-1", "links", 2, "verified", 0),
      ],
      82.5,
    );
    expect(h.categories.indexability).toMatchObject({ rulesRan: 2, deduction: 2.5, maximum: 7.4, score: 66.2, weight: 25 });
    expect(h.categories.metadata?.score).toBe(50);
    expect(h.categories.links?.score).toBe(100);
    // Categories with no rule that ran (content, images, …) are left out: (25×66.2 + 12×50 + 12×100) / 49 = 70.5
    expect(h.categories.content).toBeUndefined();
    expect(h.score).toBe(70.5);
    expect(h.partialCoverage).toBe(false);
  });

  it("flags partial coverage below 50% and has no score when no rule ran", () => {
    expect(healthScore([r("X", "site", 2, "verified", 0)], 49.9).partialCoverage).toBe(true);
    expect(healthScore([r("X", "site", 2, "verified", 0)], 50).partialCoverage).toBe(false);
    expect(healthScore([], 90)).toMatchObject({ score: null, categories: {} });
  });
});
