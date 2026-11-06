import { describe, expect, it } from "vitest";
import { RULE_TITLES } from "../rules/titles";
import { getSampleShowcase } from "./showcase";

describe("sample showcase (crawler v2 snapshot)", () => {
  const s = getSampleShowcase();

  it("is a Standard audit of the fixture shop with full coverage", () => {
    expect(s.siteName).toBe("Northwind Outdoor");
    expect(s.origin).toBe("https://www.northwind-outdoor.example");
    expect(s.profile).toBe("standard");
    expect(s.budget).toBe(1000);
    expect(s.pagesInspected).toBeGreaterThan(200);
    expect(s.coveragePercent).toBe(100);
    expect(s.health).not.toBeNull();
    expect(s.rulesRan).toBeGreaterThan(100);
  });

  it("shows catalog rule titles and grouped issues, ordered by priority score", () => {
    expect(s.groups.length).toBeGreaterThan(5);
    for (const g of s.groups) {
      expect(g.title).toBe(RULE_TITLES[g.ruleId]);
      expect(g.affectedUrls).toBeGreaterThan(0);
      expect(g.urls.length).toBe(Math.min(g.affectedUrls, 20));
      for (const u of g.urls) expect(u.url.startsWith(s.origin)).toBe(true);
      expect(g.why && g.fix && g.acceptance).toBeTruthy();
    }
    const scores = s.groups.map((g) => g.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    // The priority counts are the groups' priorities.
    const counted = { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
    for (const g of s.groups) counted[g.priority]++;
    expect(s.priorities).toEqual(counted);
  });

  it("compares against an earlier audit, and the local server origin never leaks", () => {
    expect(s.history.length).toBe(2);
    expect(s.history[1].health).toBe(s.health);
    expect(Date.parse(s.history[0].at)).toBeLessThan(Date.parse(s.history[1].at));
    expect(s.comparison?.totals.resolved).toBeGreaterThan(0);
    for (const g of s.comparison?.groups ?? []) expect(RULE_TITLES[g.ruleId]).toBeDefined();
    expect(JSON.stringify(s)).not.toMatch(/127\.0\.0\.1|localhost|:\d{4,5}\//);
  });
});
