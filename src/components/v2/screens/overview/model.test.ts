import { describe, expect, it } from "vitest";
import type { Coverage } from "@/lib/results/coverage";
import type { Health } from "@/lib/results/health";
import { changeRows, coverageGaps, decomposition, funnel, noIssuesCopy } from "./model";

const coverage: Coverage = {
  states: { analysed: 80, redirected: 10, blocked_robots: 5, budget_exhausted: 40, out_of_scope: 15, failed_timeout: 0 },
  total: 150,
  answered: 90,
  eligible: 145,
  percent: 62.1,
};

describe("funnel", () => {
  it("goes discovered → in scope → crawled with shares", () => {
    const f = funnel(coverage, null);
    expect(f.map((s) => [s.id, s.value, s.ofPrevious])).toEqual([
      ["discovered", 150, null],
      ["eligible", 145, 96.7],
      ["answered", 90, 62.1],
    ]);
    expect(f[2].ofTotal).toBe(60);
  });
  it("adds indexable when known", () => expect(funnel(coverage, 70).at(-1)).toMatchObject({ id: "indexable", value: 70, ofPrevious: 77.8 }));
  it("has no shares when nothing was discovered", () => {
    const f = funnel({ states: {}, total: 0, answered: 0, eligible: 0, percent: null }, null);
    expect(f.every((s) => s.ofTotal === null)).toBe(true);
  });
});

describe("coverageGaps", () => {
  it("lists unanswered states largest first, zeros dropped, ruled-out states marked", () => {
    expect(coverageGaps(coverage)).toEqual([
      { state: "budget_exhausted", n: 40, kind: "missed" },
      { state: "out_of_scope", n: 15, kind: "missed" },
      { state: "blocked_robots", n: 5, kind: "excluded" },
    ]);
  });
});

describe("decomposition", () => {
  const health: Health = {
    score: 77.5,
    partialCoverage: false,
    coveragePercent: 90,
    categories: {
      indexability: { weight: 25, rulesRan: 10, deduction: 1, maximum: 10, score: 90 },
      metadata: { weight: 12, rulesRan: 5, deduction: 2, maximum: 5, score: 60 },
      content: { weight: 15, rulesRan: 3, deduction: 0, maximum: 3, score: 100 },
    },
  };
  it("splits the score into per-category points that add up to it, heaviest first", () => {
    const d = decomposition(health);
    expect(d.map((c) => c.category)).toEqual(["indexability", "content", "metadata"]);
    const sum = d.reduce((n, c) => n + c.points, 0);
    // (25×90 + 15×100 + 12×60) / 52 = 85.96…
    expect(Math.abs(sum - (25 * 90 + 15 * 100 + 12 * 60) / 52)).toBeLessThan(0.2);
    expect(d[0].maxPoints).toBe(48.1);
  });
  it("is empty when no rule ran", () => expect(decomposition({ score: null, partialCoverage: true, coveragePercent: null, categories: {} })).toEqual([]));
});

describe("changeRows", () => {
  it("lists every change kind, worst first", () =>
    expect(changeRows({ new: 2, persistent: 3, resolved: 4, regressed: 1, not_rechecked: 0 })).toEqual([
      { change: "regressed", n: 1 },
      { change: "new", n: 2 },
      { change: "persistent", n: 3 },
      { change: "not_rechecked", n: 0 },
      { change: "resolved", n: 4 },
    ]));
});

describe("noIssuesCopy", () => {
  const health = (partialCoverage: boolean): Health => ({ score: 100, partialCoverage, coveragePercent: 90, categories: {} });
  it("never calls an unchecked site clean", () => {
    expect(noIssuesCopy({ rulesRan: 40, coverage: { ...coverage, answered: 0 }, health: null }).title).toBe("Nothing was crawled");
    expect(noIssuesCopy({ rulesRan: 0, coverage, health: null })).toMatchObject({ title: "No rule ran", body: expect.stringMatching(/does not mean the site has no issues/) });
  });
  it("says what was checked, and qualifies partial coverage", () => {
    expect(noIssuesCopy({ rulesRan: 40, coverage, health: health(false) })).toEqual({ title: "This audit found no issues", body: "40 rules ran over 90 crawled URLs and none found an issue." });
    expect(noIssuesCopy({ rulesRan: 1, coverage, health: health(true) }).body).toMatch(/^1 rule ran .* Coverage was partial/);
  });
});
