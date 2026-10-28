import { describe, expect, it } from "vitest";
import { csvCell, exportName, findingsToCsv } from "./export";
import { applyFilter, filterToParams, parseFilter } from "./filters";
import type { AuditFinding } from "./audit/types";

const finding = (over: Partial<AuditFinding> = {}): AuditFinding => ({
  ruleCode: "title/missing",
  ruleId: "title",
  category: "metadata",
  pageUrl: "https://example.com/a",
  severity: "high",
  kind: "defect",
  certainty: "verified",
  title: "Missing title",
  message: "",
  observed: "No <title>",
  expected: "A title",
  why: "",
  evidence: { snippets: [], facts: {} },
  recommendations: ["Add one"],
  acceptanceCriteria: [{ id: "x", description: "Has a title", params: {} }],
  scope: { kind: "page", url: "https://example.com/a" },
  verify: "page",
  fingerprint: "fp1",
  auditId: "a1",
  priority: { level: 1, score: 4, severity: "high", reasons: [] },
  ...over,
});

describe("csvCell", () => {
  it("neutralises spreadsheet formulas", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-2")).toBe("'-2");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tcmd")).toBe("'\tcmd");
  });
  it("quotes commas, quotes and newlines", () => {
    expect(csvCell('a,"b"\nc')).toBe('"a,""b""\nc"');
    expect(csvCell(null)).toBe("");
    expect(csvCell("plain")).toBe("plain");
  });
});

describe("findingsToCsv", () => {
  it("writes a header and one row per finding with the change column", () => {
    const csv = findingsToCsv([finding({ title: "=cmd|' /C calc'!A0" })], { fp1: "new" });
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines).toHaveLength(2);
    expect(lines[0].split(",")[0]).toBe("priority");
    expect(lines[1]).toContain("'=cmd");
    expect(lines[1]).toContain(",new,");
  });
});

describe("filters", () => {
  const list = [
    finding(),
    finding({ fingerprint: "fp2", ruleCode: "images/missing-alt", category: "images", pageUrl: "https://example.com/b", priority: { level: 3, score: 2, severity: "low", reasons: [] } }),
  ];
  it("filters by severity, category, change and text", () => {
    expect(applyFilter(list, { severity: ["low"] }, null).map((f) => f.fingerprint)).toEqual(["fp2"]);
    expect(applyFilter(list, { category: ["metadata"] }, null).map((f) => f.fingerprint)).toEqual(["fp1"]);
    expect(applyFilter(list, { change: ["new"] }, { fp1: "persistent", fp2: "new" }).map((f) => f.fingerprint)).toEqual(["fp2"]);
    expect(applyFilter(list, { change: ["new"] }, null)).toEqual([]);
    expect(applyFilter(list, { q: "/B" }, null).map((f) => f.fingerprint)).toEqual(["fp2"]);
  });
  it("round-trips through URL params", () => {
    const f = { severity: ["high" as const], q: "x y", change: ["regression" as const] };
    expect(parseFilter(filterToParams(f))).toMatchObject(f);
  });
});

describe("exportName", () => {
  it("slugs the site name", () => {
    expect(exportName("Harbor Family Dental!", "2026-10-15T09:00:00Z", "findings.csv")).toBe("harbor-family-dental-2026-10-15-findings.csv");
  });
});
