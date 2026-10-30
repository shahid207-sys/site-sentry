import { describe, expect, it } from "vitest";
import type { IssueRow } from "@/lib/results/explore";
import type { IssueGroupRow } from "@/lib/results/queries";
import {
  assignBatches,
  chunk,
  filterGroups,
  filterIssues,
  indexRows,
  issueSortKey,
  NO_FILTERS,
  parseSubject,
  REGEX_MAX,
  rowMarker,
  ruleFacts,
  stateSummary,
  templateOptions,
  textMatcher,
  type IssueFilters,
} from "./filter";

const row = (over: Partial<IssueRow>): IssueRow => ({
  fingerprint: "fp",
  ruleId: "IDX-001",
  url: "https://example.com/",
  state: "new",
  outcome: "issue",
  templateId: null,
  message: null,
  verified: false,
  ...over,
});

const group = (over: Partial<IssueGroupRow>): IssueGroupRow => ({
  ruleId: "IDX-001",
  category: "indexability",
  impact: 5,
  confidence: "verified",
  confidenceWeight: 1,
  affectedPages: 1,
  indexablePages: 10,
  reach: 0.3,
  score: 1.5,
  priority: "medium",
  affectedUrls: 1,
  inconclusiveUrls: 0,
  templateCount: 1,
  sampleUrls: [],
  templates: [],
  states: { new: 1 },
  ...over,
});

const ROWS: IssueRow[] = [
  row({ fingerprint: "a", ruleId: "IDX-001", url: "https://example.com/Products/1", state: "new", templateId: "t1" }),
  row({ fingerprint: "b", ruleId: "IDX-001", url: "https://example.com/blog/2", state: "resolved", templateId: "t2" }),
  row({ fingerprint: "c", ruleId: "META-001", url: "https://example.com/products/3", state: "not_rechecked", templateId: "t1" }),
  row({ fingerprint: "d", ruleId: "CNT-001", url: "https://example.com/about", state: "inconclusive", templateId: null }),
];
const FACTS = ruleFacts([group({ ruleId: "IDX-001", priority: "critical", category: "indexability" }), group({ ruleId: "META-001", priority: "low", category: "metadata" })], new Map([["CNT-001", { category: "content" }]]));
const run = (f: Partial<IssueFilters>) => filterIssues(ROWS, indexRows(ROWS), { ...NO_FILTERS, ...f }, FACTS).map((r) => r.fingerprint);

describe("textMatcher", () => {
  it("is inactive when empty", () => expect(textMatcher("  ").active).toBe(false));
  it("matches a plain substring case-insensitively", () => expect(textMatcher("PRODUCTS")).toMatchObject({ active: true, needle: "products", regex: null }));
  it("compiles a regex after re:", () => expect(textMatcher("re:/products/\\d+$").regex?.test("https://x/products/12")).toBe(true));
  it("ignores an invalid regex with a reason", () => {
    const m = textMatcher("re:(");
    expect(m.active).toBe(false);
    expect(m.error).toMatch(/Not a valid regex/);
  });
  it("caps the regex length", () => {
    const m = textMatcher(`re:${"a".repeat(REGEX_MAX + 1)}`);
    expect(m.active).toBe(false);
    expect(m.error).toMatch(/longer than/);
  });
});

describe("filterIssues", () => {
  it("returns the same array without filters", () => expect(filterIssues(ROWS, indexRows(ROWS), NO_FILTERS, FACTS)).toBe(ROWS));
  it("filters by URL substring, any case", () => expect(run({ text: "products" })).toEqual(["a", "c"]));
  it("filters by rule id substring", () => expect(run({ text: "meta-" })).toEqual(["c"]));
  it("filters by regex", () => expect(run({ text: "re:/products/[13]$" })).toEqual(["a", "c"]));
  it("ignores an invalid regex instead of hiding everything", () => expect(run({ text: "re:[" })).toEqual(["a", "b", "c", "d"]));
  it("filters by one state or by open", () => {
    expect(run({ state: "resolved" })).toEqual(["b"]);
    expect(run({ state: "open" })).toEqual(["a", "c"]);
  });
  it("joins priority through the rule's group; none = no group", () => {
    expect(run({ priority: "critical" })).toEqual(["a", "b"]);
    expect(run({ priority: "none" })).toEqual(["d"]);
  });
  it("filters by category, falling back to the catalog", () => {
    expect(run({ category: "metadata" })).toEqual(["c"]);
    expect(run({ category: "content" })).toEqual(["d"]);
  });
  it("filters by template and by no template", () => {
    expect(run({ template: "t1" })).toEqual(["a", "c"]);
    expect(run({ template: "none" })).toEqual(["d"]);
  });
  it("combines filters", () => expect(run({ text: "products", state: "open", priority: "low" })).toEqual(["c"]));

  it("filters 50,000 rows well under the 200 ms gate", () => {
    const big = Array.from({ length: 50_000 }, (_, i) => row({ fingerprint: `f${i}`, ruleId: `R-${i % 40}`, url: `https://example.com/section-${i % 97}/page-${i}`, templateId: `t${i % 7}` }));
    const index = indexRows(big);
    const t0 = performance.now();
    const out = filterIssues(big, index, { ...NO_FILTERS, text: "section-5/" }, new Map());
    const plain = performance.now() - t0;
    const t1 = performance.now();
    filterIssues(big, index, { ...NO_FILTERS, text: "re:page-\\d*7$", template: "t3" }, new Map());
    const regex = performance.now() - t1;
    expect(out.length).toBeGreaterThan(0);
    expect(plain).toBeLessThan(200);
    expect(regex).toBeLessThan(200);
  });
});

describe("filterGroups", () => {
  const groups = [
    group({ ruleId: "IDX-001", priority: "critical", states: { resolved: 2 }, templates: [{ templateId: "t1", affectedUrls: 2, sampleUrls: [] }] }),
    group({ ruleId: "META-001", category: "metadata", priority: "low", states: { persistent: 1 } }),
  ];
  const title = (id: string) => (id === "META-001" ? "Missing title" : id);
  const ids = (f: Partial<IssueFilters>) => filterGroups(groups, { ...NO_FILTERS, ...f }, title).map((g) => g.ruleId);
  it("matches text on the rule title", () => expect(ids({ text: "title" })).toEqual(["META-001"]));
  it("keeps a group with any fingerprint in the state", () => expect(ids({ state: "open" })).toEqual(["META-001"]));
  it("filters by priority, category, template and rule", () => {
    expect(ids({ priority: "critical" })).toEqual(["IDX-001"]);
    expect(ids({ category: "metadata" })).toEqual(["META-001"]);
    expect(ids({ template: "t1" })).toEqual(["IDX-001"]);
    expect(ids({ rule: "META-001" })).toEqual(["META-001"]);
  });
});

describe("helpers", () => {
  it("sorts priority by rank with no group last", () => {
    expect(issueSortKey(ROWS[0], "priority", FACTS)).toBe(0);
    expect(issueSortKey(ROWS[3], "priority", FACTS)).toBe(5);
  });
  it("lists templates by count", () => expect(templateOptions(ROWS)).toEqual([{ id: "t1", count: 2 }, { id: "t2", count: 1 }]));
  it("summarises states in display order without zeros", () => expect(stateSummary({ resolved: 1, new: 2, persistent: 0 })).toEqual([{ state: "new", n: 2 }, { state: "resolved", n: 1 }]));
  it("parses drawer subjects", () => {
    expect(parseSubject("rule:IDX-001")).toEqual({ kind: "rule", id: "IDX-001" });
    expect(parseSubject("fp:abc")).toEqual({ kind: "fp", id: "abc" });
    expect(parseSubject("fp:")).toBeNull();
    expect(parseSubject("x")).toBeNull();
  });
  it("words triage markers and never invents one", () => {
    expect(rowMarker({ status: "fixed", note: null })).toBe("Marked fixed");
    expect(rowMarker({ status: "ignored", note: "Intentional" })).toBe("Ignored: Intentional");
    expect(rowMarker({ status: "todo", note: null })).toBeNull();
    expect(rowMarker(undefined)).toBeNull();
  });
  it("chunks at the API's batch size", () => expect(chunk(Array.from({ length: 12_001 }, (_, i) => i)).map((c) => c.length)).toEqual([5000, 5000, 2001]));
  it("assigns without changing status or losing an ignore reason", () => {
    const index = new Map([
      ["fp:a", { status: "fixed" as const, note: null }],
      ["fp:b", { status: "ignored" as const, note: "Staging only" }],
      ["fp:c", { status: "ignored" as const, note: "Staging only" }],
    ]);
    expect(assignBatches(["fp:a", "fp:b", "fp:c", "fp:d"], index)).toEqual([
      { subjects: ["fp:a"], status: "fixed", note: undefined },
      { subjects: ["fp:b", "fp:c"], status: "ignored", note: "Staging only" },
      { subjects: ["fp:d"], status: "todo", note: undefined },
    ]);
  });
});
