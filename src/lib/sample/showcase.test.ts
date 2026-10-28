import { describe, expect, it, vi } from "vitest";

vi.mock("next/cache", () => ({ cacheLife: () => {} }));

import { countIssueTypes, healthScore } from "../audit/health";
import { getSampleShowcase } from "./showcase";

describe("sample showcase", () => {
  it("is derived from the sample seed, not hand-written", async () => {
    const s = await getSampleShowcase();
    expect(s.siteName).toBe("Northwind Outdoor");
    // The score is the documented formula applied to the open issue types it lists.
    expect(s.health).toBe(healthScore(s.openTypes));
    const types = countIssueTypes(s.issues.map((i) => ({ ruleCode: i.ruleCode, priority: { severity: i.severity } })));
    expect(types).toEqual(s.openTypes);
    expect(s.issues.length).toBeGreaterThan(0);
    // Every fetched URL is listed, including ones that couldn't be inspected.
    expect(s.pages.length).toBeGreaterThanOrEqual(s.pagesInspected);
    expect(s.history.length).toBe(2);
    // Every issue carries an engine rule code and the pages it was found on.
    for (const i of s.issues) {
      expect(i.ruleCode).toMatch(/^[a-z-]+\/[a-z0-9-]+$/);
      expect(i.pages.length).toBeGreaterThan(0);
      expect(i.criteria.length).toBeGreaterThan(0);
    }
  });
});
