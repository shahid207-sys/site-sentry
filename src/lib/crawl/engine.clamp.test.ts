import { describe, expect, it } from "vitest";
import type { AuditConfig } from "../model";
import { sampleFetcher } from "../sample/fetcher";
import { SAMPLE_SITES } from "../sample/fixtures";
import { MemoryStore } from "../store/store";
import type { Deps } from "../workflow/deps";
import { clampToLegacyEngine, createAudit, runAuditToCompletion } from "./engine";

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

describe("engine_limit and audit status", () => {
  const HD = SAMPLE_SITES[1].origin;
  const NW = SAMPLE_SITES[0].origin;
  async function run(origin: string, config: AuditConfig, coverage = clampToLegacyEngine(config).coverage) {
    const store = new MemoryStore();
    let n = 0;
    const deps = { store, fetch: sampleFetcher("original"), now: () => new Date(0), newId: () => `t-${++n}`, source: "sample", clockMs: () => 0 } as Deps;
    await store.update((d) => {
      d.sites.s = { id: "s", name: "Sample", origin, createdAt: new Date(0).toISOString() };
    });
    const { audit } = await createAudit({ siteId: "s", config: clampToLegacyEngine(config).config, coverage }, deps);
    return runAuditToCompletion(audit.id, deps);
  }

  it("is not partial when the clamp cut nothing: the small site was covered within 100 URLs and 3 clicks", async () => {
    const a = await run(HD, cfg({ profile: "standard", urls: [`${HD}/`], maxPages: 1000, maxDepth: 10 }));
    expect(a.coverage.map((c) => c.code)).toEqual(["engine_limit"]);
    expect(a.status).toBe("completed");
  });

  it("is partial when links were left unfollowed at the clamped depth, but not for a depth the user chose", async () => {
    const config = cfg({ profile: "custom", urls: [`${NW}/`], maxPages: 1000, maxDepth: 1 });
    const engineLimit = { code: "engine_limit" as const, message: "clamped" };
    const clamped = await run(NW, config, [engineLimit]);
    expect(clamped.coverage.map((c) => c.code)).toEqual(expect.arrayContaining(["engine_limit", "depth_limit"]));
    expect(clamped.status).toBe("partial");
    const chosen = await run(NW, config, []);
    expect(chosen.coverage.map((c) => c.code)).toContain("depth_limit");
    expect(chosen.status).toBe("completed");
  });
});
