import { describe, expect, it } from "vitest";
import type { Comparison, CrawlOverview, GroupComparison } from "../results/queries";
import { regressionAlert, signBody, verifySignature } from "./alert";

const overview = (crawlId: string, createdAt: string, score: number | null): CrawlOverview =>
  ({ crawlId, workspace: "live", project: "s1", siteOrigin: "https://a.test", profile: "custom", status: "completed", createdAt, analysed: true, health: score === null ? null : { score }, states: {} } as unknown as CrawlOverview);

const counts = (c: Partial<GroupComparison["counts"]>): GroupComparison["counts"] => ({ new: 0, persistent: 0, resolved: 0, regressed: 0, not_rechecked: 0, inconclusive: 0, ...c });

const cmp = (groups: GroupComparison[]): Comparison => ({
  base: overview("c-base", "2026-10-01T00:00:00.000Z", 80),
  head: overview("c-head", "2026-10-02T00:00:00.000Z", 72),
  groups,
  totals: { new: groups.filter((g) => g.change === "new").length, persistent: 0, resolved: groups.filter((g) => g.change === "resolved").length, regressed: groups.filter((g) => g.change === "regressed").length, not_rechecked: 0 },
  scopeMismatch: false,
  warnings: [],
});

const ctx = { scheduleId: "sch-1", site: { id: "s1", name: "A", origin: "https://a.test" }, auditId: "a-2", url: null };

describe("regressionAlert", () => {
  it("is null when nothing got worse (resolved, persistent and not re-checked do not alert)", () => {
    expect(regressionAlert(cmp([]), ctx)).toBeNull();
    expect(
      regressionAlert(
        cmp([
          { ruleId: "META-003", change: "resolved", counts: counts({ resolved: 3 }) },
          { ruleId: "META-005", change: "persistent", counts: counts({ persistent: 2 }) },
          { ruleId: "IDX-001", change: "not_rechecked", counts: counts({ not_rechecked: 1 }) },
        ]),
        ctx,
      ),
    ).toBeNull();
  });

  it("lists the regressed and new groups, regressed first, with their fingerprint counts", () => {
    const a = regressionAlert(
      cmp([
        { ruleId: "META-005", change: "persistent", counts: counts({ persistent: 2 }) },
        { ruleId: "IMG-001", change: "new", counts: counts({ new: 5 }) },
        { ruleId: "META-003", change: "regressed", counts: counts({ regressed: 3, persistent: 1 }) },
        { ruleId: "LNK-001", change: "new", counts: counts({ new: 9 }) },
      ]),
      ctx,
    )!;
    expect(a.event).toBe("audit.regression");
    expect(a.groups).toEqual([
      { ruleId: "META-003", change: "regressed", fingerprints: 3 },
      { ruleId: "LNK-001", change: "new", fingerprints: 9 },
      { ruleId: "IMG-001", change: "new", fingerprints: 5 },
    ]);
    expect(a.health).toEqual({ before: 80, after: 72 });
    expect(a.base.crawlId).toBe("c-base");
    expect(a.audit).toMatchObject({ id: "a-2", crawlId: "c-head" });
    expect(a.totals.regressed).toBe(1);
    expect(a.totals.new).toBe(2);
  });
});

describe("signatures", () => {
  it("verifies only the exact body with the same secret", () => {
    const body = JSON.stringify({ a: 1 });
    const sig = signBody(body, "s3cret");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(verifySignature(body, "s3cret", sig)).toBe(true);
    expect(verifySignature(body + " ", "s3cret", sig)).toBe(false);
    expect(verifySignature(body, "other", sig)).toBe(false);
    expect(verifySignature(body, "s3cret", null)).toBe(false);
    expect(verifySignature(body, "s3cret", "sha256=00")).toBe(false);
  });
});
