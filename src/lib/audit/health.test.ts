import { describe, expect, it } from "vitest";
import { countIssueTypes, healthBand, healthScore } from "./health";

describe("health score", () => {
  it("deducts per issue type by severity and never goes below zero", () => {
    expect(healthScore({ high: 0, medium: 0, low: 0 })).toBe(100);
    expect(healthScore({ high: 1, medium: 2, low: 3 })).toBe(100 - 10 - 6 - 3);
    expect(healthScore({ high: 12, medium: 0, low: 0 })).toBe(0);
  });

  it("counts a check once per site, at its worst severity", () => {
    const f = (ruleCode: string, severity: "high" | "medium" | "low") => ({ ruleCode, priority: { severity } });
    const types = countIssueTypes([f("images/missing-dimensions", "low"), f("images/missing-dimensions", "low"), f("title/missing", "high"), f("title/missing", "medium")]);
    expect(types).toEqual({ high: 1, medium: 0, low: 1 });
  });

  it("bands scores", () => {
    expect([healthBand(95), healthBand(70), healthBand(40)]).toEqual(["good", "fair", "poor"]);
  });
});
