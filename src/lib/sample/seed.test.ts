import { describe, expect, it } from "vitest";
import { buildSampleSeed } from "./seed";

describe("sample seed", () => {
  it("builds deterministically with audits, tasks and verifications", async () => {
    const a = await buildSampleSeed();
    const b = await buildSampleSeed();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const audits = Object.values(a.state.audits);
    expect(audits).toHaveLength(4);
    expect(audits.every((x) => x.status === "completed" || x.status === "partial")).toBe(true);
    const tasks = Object.values(a.state.tasks);
    expect(tasks.length).toBeGreaterThanOrEqual(6);
    expect(tasks.some((t) => t.verifications.length > 0)).toBe(true);
    for (const id of Object.keys(a.state.audits)) expect(a.blobs[id].snapshots.length).toBeGreaterThan(0);
  });
});

describe("homepage product preview", () => {
  it("shows a real finding whose criteria fail on the original fixture and pass on the fixed one", async () => {
    const { buildProductPreview } = await import("./preview");
    const p = buildProductPreview();
    expect(p.finding.ruleCode).toBe("canonical/expected-url");
    expect(p.before.some((c) => !c.passed)).toBe(true);
    expect(p.after.length).toBeGreaterThan(0);
    expect(p.after.every((c) => c.passed)).toBe(true);
  });
});
