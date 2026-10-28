import { describe, expect, it } from "vitest";
import { describeLimits, MAX_BUDGET, normaliseSubfolder, PROFILES, regexProblem, resolveProfile } from "./profiles";

describe("crawl profiles", () => {
  it("match the spec table", () => {
    expect(PROFILES.quick).toMatchObject({ budget: 25, maxDepth: 3 });
    expect(PROFILES.standard).toMatchObject({ budget: 1_000, maxDepth: 10 });
    expect(PROFILES.full).toMatchObject({ budget: 50_000, maxDepth: null, budgetEditable: true });
    expect(PROFILES.custom).toMatchObject({ budgetEditable: true, depthEditable: true, scopeRules: true });
  });

  it("fixes Quick and Standard, lets Full-site set the budget and Custom set both", () => {
    expect(resolveProfile({ profile: "quick" })).toEqual({ profile: "quick", budget: 25, maxDepth: 3 });
    expect(resolveProfile({ profile: "standard", budget: 1000 })).toEqual({ profile: "standard", budget: 1000, maxDepth: 10 });
    expect(() => resolveProfile({ profile: "quick", budget: 500 })).toThrow("fixed budget of 25");
    expect(() => resolveProfile({ profile: "standard", maxDepth: 2 })).toThrow("fixed depth (10)");
    expect(resolveProfile({ profile: "full" })).toEqual({ profile: "full", budget: 50_000, maxDepth: null });
    expect(resolveProfile({ profile: "full", budget: 120_000 })).toMatchObject({ budget: 120_000, maxDepth: null });
    expect(() => resolveProfile({ profile: "full", maxDepth: 4 })).toThrow("fixed depth (unlimited)");
    expect(resolveProfile({ profile: "custom", budget: 40, maxDepth: null })).toEqual({ profile: "custom", budget: 40, maxDepth: null });
    expect(resolveProfile({ profile: "custom", maxDepth: 0 })).toMatchObject({ budget: 1000, maxDepth: 0 });
  });

  it("rejects out-of-range user values", () => {
    expect(() => resolveProfile({ profile: "full", budget: 0 })).toThrow("Budget must be");
    expect(() => resolveProfile({ profile: "full", budget: MAX_BUDGET + 1 })).toThrow("Budget must be");
    expect(() => resolveProfile({ profile: "custom", maxDepth: -1 })).toThrow("Depth must be");
    expect(() => resolveProfile({ profile: "custom", budget: 2.5 })).toThrow("Budget must be");
  });

  it("validates include/exclude patterns", () => {
    expect(regexProblem("^https://a\\.test/blog/")).toBeNull();
    expect(regexProblem("(")).toMatch(/Unterminated group|Invalid regular expression/);
    expect(regexProblem("")).toBe("Empty pattern.");
    expect(regexProblem("a".repeat(501))).toBe("Longer than 500 characters.");
  });

  it("normalises a subfolder to a /prefix/", () => {
    expect(normaliseSubfolder("/blog")).toBe("/blog/");
    expect(normaliseSubfolder(" /docs/v2/ ")).toBe("/docs/v2/");
    expect(normaliseSubfolder("blog")).toBeNull();
    expect(normaliseSubfolder("/a/../b")).toBeNull();
    expect(normaliseSubfolder("/a?x=1")).toBeNull();
    expect(normaliseSubfolder("")).toBeNull();
  });

  it("describes limits in one line", () => {
    expect(describeLimits(1000, 10)).toBe("1,000 URLs · 10 clicks deep");
    expect(describeLimits(50_000, null)).toBe("50,000 URLs · unlimited depth");
    expect(describeLimits(25, 0)).toBe("25 URLs · no link following");
  });
});
