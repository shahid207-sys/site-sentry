import { describe, expect, it } from "vitest";
import type { AuditConfig } from "../model";
import { clampToLegacyEngine } from "./engine";

const cfg = (c: Partial<AuditConfig>): AuditConfig => ({ mode: "single", urls: ["https://a.test/"], maxPages: 25, maxDepth: 3, categories: ["crawlability"], checkLinks: false, includeImportant: false, ...c });

describe("clampToLegacyEngine", () => {
  it("leaves a profile the in-request engine can run unchanged, with no note", () => {
    const c = cfg({ profile: "quick" });
    expect(clampToLegacyEngine(c)).toEqual({ config: c, coverage: [] });
  });

  it("clamps budget and unlimited depth, and the note states both the request and what runs", () => {
    const { config, coverage } = clampToLegacyEngine(cfg({ profile: "full", maxPages: 50_000, maxDepth: null }));
    expect(config).toMatchObject({ profile: "full", maxPages: 100, maxDepth: 3 });
    expect(coverage).toEqual([
      {
        code: "engine_limit",
        message:
          "The Full-site profile asks for 50,000 URLs · unlimited depth. The in-request engine running this audit (crawler v2 is off) stops at 100 URLs · 3 clicks deep, so this audit covers at most that.",
      },
    ]);
  });

  it("clamps depth alone", () => {
    expect(clampToLegacyEngine(cfg({ maxDepth: 10 })).config.maxDepth).toBe(3);
    expect(clampToLegacyEngine(cfg({ maxDepth: 10 })).coverage[0].message).toMatch(/^This audit asked for 25 URLs · 10 clicks deep\./);
  });
});
