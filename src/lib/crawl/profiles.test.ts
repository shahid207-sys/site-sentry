import { describe, expect, it } from "vitest";
import { describeLimits, MAX_BUDGET, normaliseSubfolder, PROFILES, resolveProfile } from "./profiles";

describe("crawl profiles", () => {
  it("match the spec table", () => {
    expect(PROFILES.quick).toMatchObject({ budget: 25, maxDepth: 3 });
    expect(PROFILES.standard).toMatchObject({ budget: 1_000, maxDepth: 10 });
    expect(PROFILES.full).toMatchObject({ budget: 50_000, maxDepth: null, budgetEditable: true });
    expect(PROFILES.custom).toMatchObject({ budgetEditable: true, depthEditable: true, scopeRules: true });
  });

  it("fixes Quick and Standard, lets Full-site set the budget and Custom set both", () => {
    expect(resolveProfile({ profile: "quick" })).toEqual({ profile: "quick", budget: 25, maxDepth: 3, render: "off" });
    expect(resolveProfile({ profile: "standard", budget: 1000 })).toEqual({ profile: "standard", budget: 1000, maxDepth: 10, render: "sampled" });
    expect(() => resolveProfile({ profile: "quick", budget: 500 })).toThrow("fixed budget of 25");
    expect(() => resolveProfile({ profile: "standard", maxDepth: 2 })).toThrow("fixed depth (10)");
    expect(resolveProfile({ profile: "full" })).toEqual({ profile: "full", budget: 50_000, maxDepth: null, render: "sampled" });
    expect(resolveProfile({ profile: "full", budget: 120_000 })).toMatchObject({ budget: 120_000, maxDepth: null });
    expect(() => resolveProfile({ profile: "full", maxDepth: 4 })).toThrow("fixed depth (unlimited)");
    expect(resolveProfile({ profile: "custom", budget: 40, maxDepth: null })).toEqual({ profile: "custom", budget: 40, maxDepth: null, render: "off" });
    expect(resolveProfile({ profile: "custom", maxDepth: 0 })).toMatchObject({ budget: 1000, maxDepth: 0 });
  });

  it("renders as the spec table says: Quick off, Standard sampled, Full-site sampled or full, Custom any", () => {
    expect(PROFILES.quick.render).toEqual(["off"]);
    expect(PROFILES.standard.render).toEqual(["sampled"]);
    expect(PROFILES.full.render).toEqual(["sampled", "full"]);
    expect(PROFILES.custom.render).toEqual(["off", "sampled", "full"]);
    expect(resolveProfile({ profile: "full", render: "full" }).render).toBe("full");
    expect(resolveProfile({ profile: "custom", render: "sampled" }).render).toBe("sampled");
    expect(resolveProfile({ profile: "standard", render: "sampled" }).render).toBe("sampled");
    expect(() => resolveProfile({ profile: "quick", render: "full" })).toThrow('The Quick profile renders with mode "off" only.');
    expect(() => resolveProfile({ profile: "standard", render: "off" })).toThrow('with mode "sampled" only');
    expect(() => resolveProfile({ profile: "full", render: "off" })).toThrow('The Full-site profile renders with "sampled" or "full".');
  });

  it("rejects out-of-range user values", () => {
    expect(() => resolveProfile({ profile: "full", budget: 0 })).toThrow("Budget must be");
    expect(() => resolveProfile({ profile: "full", budget: MAX_BUDGET + 1 })).toThrow("Budget must be");
    expect(() => resolveProfile({ profile: "custom", maxDepth: -1 })).toThrow("Depth must be");
    expect(() => resolveProfile({ profile: "custom", budget: 2.5 })).toThrow("Budget must be");
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
