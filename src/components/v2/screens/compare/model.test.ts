import { describe, expect, it } from "vitest";
import type { CrawlOverview, GroupComparison } from "@/lib/results/queries";
import type { AuditSummary } from "@/lib/views";
import { beforeAfter, comparableAudits, compareSortKey, defaultOrder, filterByChange, issuesHref, openFindings, parseChange, totalFingerprints, trend } from "./model";

const counts = (c: Partial<GroupComparison["counts"]> = {}): GroupComparison["counts"] => ({ new: 0, persistent: 0, resolved: 0, regressed: 0, not_rechecked: 0, inconclusive: 0, ...c });
const group = (ruleId: string, change: GroupComparison["change"], c: Partial<GroupComparison["counts"]> = {}): GroupComparison => ({ ruleId, change, counts: counts(c) });

const audit = (id: string, startedAt: string, over: { status?: AuditSummary["status"]; analysis?: "running" | "completed" | "failed" | undefined; v2?: boolean } = {}): AuditSummary =>
  ({
    id,
    siteId: "s",
    startedAt,
    status: over.status ?? "completed",
    crawler: over.v2 === false ? undefined : { version: 2, crawlId: `c-${id}`, status: "completed", states: {}, analysis: "analysis" in over ? over.analysis : "completed", syncedAt: startedAt },
  }) as unknown as AuditSummary;

const overview = (o: { score?: number | null; health?: boolean; states?: Partial<CrawlOverview["states"]>; groups?: number; coverage?: number | null }): CrawlOverview =>
  ({
    health: o.health === false ? null : { score: o.score ?? null, partialCoverage: false, coveragePercent: null, categories: {} },
    states: { new: 0, persistent: 0, resolved: 0, regressed: 0, not_rechecked: 0, inconclusive: 0, ...o.states },
    issueGroups: o.groups ?? 0,
    coverage: { states: {}, total: 0, answered: 0, eligible: 0, percent: o.coverage ?? null },
  }) as unknown as CrawlOverview;

describe("comparableAudits", () => {
  it("keeps analysed v2 audits started before the current one, newest first", () => {
    const list = [
      audit("cur", "2026-05-03"),
      audit("later", "2026-05-04"),
      audit("a", "2026-05-01"),
      audit("b", "2026-05-02"),
      audit("legacy", "2026-04-01", { v2: false }),
      audit("unanalysed", "2026-04-02", { analysis: "running" }),
      audit("noanalysis", "2026-04-03", { analysis: undefined }),
      audit("running", "2026-04-04", { status: "running" }),
    ];
    expect(comparableAudits(list, "cur").map((a) => a.id)).toEqual(["b", "a"]);
  });
  it("is empty when the site has only the current audit, or none", () => {
    expect(comparableAudits([audit("cur", "2026-05-03")], "cur")).toEqual([]);
    expect(comparableAudits([], "cur")).toEqual([]);
  });
  it("does not filter by date when the current audit is not in the list", () => {
    expect(comparableAudits([audit("x", "2030-01-01")], "cur").map((a) => a.id)).toEqual(["x"]);
  });
});

describe("change filter and order", () => {
  const groups = [
    group("META-001", "resolved", { resolved: 9 }),
    group("CNT-005", "new", { new: 2 }),
    group("LNK-004", "regressed", { regressed: 1, inconclusive: 1 }),
    group("CNT-001", "new", { new: 5 }),
    group("IDX-001", "not_rechecked", { not_rechecked: 3 }),
    group("META-008", "persistent", { persistent: 4, resolved: 1 }),
  ];
  it("parses only known changes", () => {
    expect(parseChange("regressed")).toBe("regressed");
    expect(parseChange("inconclusive")).toBeNull();
    expect(parseChange(null)).toBeNull();
  });
  it("filters by change", () => {
    expect(filterByChange(groups, "new").map((g) => g.ruleId)).toEqual(["CNT-005", "CNT-001"]);
    expect(filterByChange(groups, null)).toBe(groups);
    expect(filterByChange([], "new")).toEqual([]);
  });
  it("orders worse changes first, then by size", () => {
    expect(defaultOrder(groups).map((g) => g.ruleId)).toEqual(["LNK-004", "CNT-001", "CNT-005", "META-008", "IDX-001", "META-001"]);
  });
  it("gives sort keys per column", () => {
    const g = groups[5];
    expect(totalFingerprints(g)).toBe(5);
    expect(compareSortKey(g, "total", (x) => x)).toBe(5);
    expect(compareSortKey(g, "resolved", (x) => x)).toBe(1);
    expect(compareSortKey(g, "change", (x) => x)).toBe(2);
    expect(compareSortKey(g, "rule", () => "Missing Meta")).toBe("missing meta");
    expect(compareSortKey(g, "unknown", (x) => x)).toBeNull();
  });
});

describe("issuesHref", () => {
  it("opens open groups grouped, and resolved / not re-checked ones as a flat list in that state", () => {
    expect(issuesHref("/live/audits/1", { ruleId: "META-001", change: "new" })).toBe("/live/audits/1/issues?rule=META-001&expand=META-001");
    expect(issuesHref("/live/audits/1", { ruleId: "META-001", change: "resolved" })).toBe("/live/audits/1/issues?view=flat&rule=META-001&state=resolved");
    expect(issuesHref("/live/audits/1", { ruleId: "A B", change: "not_rechecked" })).toBe("/live/audits/1/issues?view=flat&rule=A%20B&state=not_rechecked");
  });
});

describe("beforeAfter", () => {
  it("sums open states and computes deltas with direction", () => {
    const rows = beforeAfter(
      overview({ score: 61.2, states: { new: 3, persistent: 2, regressed: 1, not_rechecked: 4, inconclusive: 9, resolved: 0 }, groups: 7, coverage: 80 }),
      overview({ score: 70, states: { new: 1, persistent: 2, resolved: 6 }, groups: 4, coverage: null }),
    );
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(openFindings({ new: 3, persistent: 2, regressed: 1, not_rechecked: 4, inconclusive: 9 })).toBe(10);
    expect(by.health).toMatchObject({ before: 61.2, after: 70, delta: 8.8 });
    expect(trend(by.health)).toBe("better");
    expect(by.open).toMatchObject({ before: 10, after: 3, delta: -7 });
    expect(trend(by.open)).toBe("better");
    expect(by.groups.delta).toBe(-3);
    expect(by.resolved).toMatchObject({ before: 0, after: 6 });
    expect(by.coverage.delta).toBeNull();
    expect(trend(by.coverage)).toBeNull();
  });
  it("handles audits without a health score", () => {
    const rows = beforeAfter(overview({ health: false }), overview({ score: 50 }));
    expect(rows[0]).toMatchObject({ before: null, after: 50, delta: null });
    expect(trend({ delta: 0, higherIsBetter: true })).toBe("same");
    expect(trend({ delta: 2, higherIsBetter: false })).toBe("worse");
  });
});
