import { describe, expect, it } from "vitest";
import type { PageSnapshot } from "../model";
import { compareAudits } from "./compare";
import { groupIssues } from "./groups";
import { LEGACY_V1_NOTE } from "./legacy";
import { DEFAULT_RULE_CONFIG, type AuditFinding, type RuleCategory, type RuleResult } from "./types";

const O = "https://example.com";

function audit(categories: RuleCategory[], coverage: { code: string; message: string }[] = []) {
  return { config: { mode: "single", urls: [`${O}/`], maxPages: 25, maxDepth: 1, categories, checkLinks: false, includeImportant: false }, robots: null, sitemap: null, linkChecks: {}, coverage, ruleConfig: DEFAULT_RULE_CONFIG, status: "completed" } as never;
}

function rule(ruleId: string, category: RuleCategory, checked?: string[]): RuleResult {
  return { ruleId, name: ruleId, category, status: "pass", findings: [], facts: {}, snippets: [], missingExpectations: [], ...(checked ? { checked } : {}) };
}

function page(path: string, rules: RuleResult[]): PageSnapshot {
  const url = `${O}${path}`;
  return { url, finalUrl: url, status: 200, redirectChain: [], outcome: "inspected", truncated: false, rules, expectations: {} } as unknown as PageSnapshot;
}

function finding(ruleCode: string, path: string, over: Partial<AuditFinding> = {}): AuditFinding {
  const [ruleId] = ruleCode.split("/");
  const url = `${O}${path}`;
  return {
    ruleCode, ruleId, category: "metadata", pageUrl: url, severity: "low", kind: "warning", certainty: "verified", title: ruleCode, message: "", observed: "x", expected: "y", why: "",
    evidence: { snippets: [], facts: {} }, recommendations: [], acceptanceCriteria: [], scope: { kind: "page", url }, verify: "page",
    fingerprint: `${ruleCode}@${path}`, auditId: "head", priority: { level: 3, score: 2, severity: "low", reasons: [] }, ...over,
  };
}

describe("compareAudits baseline coverage", () => {
  it("reports findings outside a narrower baseline as first detections, never regressions", () => {
    const base = { audit: audit(["metadata"]), pages: [page("/", [rule("title", "metadata")])], findings: [] };
    const head = {
      audit: audit(["metadata", "images"]),
      pages: [page("/", [rule("title", "metadata"), rule("images", "images")]), page("/about", [rule("title", "metadata")])],
      findings: [finding("images/missing-dimensions", "/", { category: "images" }), finding("title/too-long", "/about")],
    };
    const c = compareAudits(base, head);
    expect(c.counts.regression).toBe(0);
    expect(c.counts.new).toBe(2);
    expect(c.newCoverage).toEqual([`${O}/about`]);
  });

  it("calls a finding a regression only when the earlier audit ran that exact check on that page", () => {
    const base = { audit: audit(["metadata"]), pages: [page("/", [rule("title", "metadata")])], findings: [] };
    const head = { audit: audit(["metadata"]), pages: [page("/", [rule("title", "metadata")])], findings: [finding("title/too-long", "/")] };
    expect(compareAudits(base, head).counts.regression).toBe(1);
  });

  it("does not treat checks a snapshot did not evaluate as covered", () => {
    const base = { audit: audit(["metadata"]), pages: [page("/", [rule("title", "metadata", ["title/missing"])])], findings: [] };
    const head = { audit: audit(["metadata"]), pages: [page("/", [rule("title", "metadata")])], findings: [finding("title/too-long", "/")] };
    const c = compareAudits(base, head);
    expect(c.counts.regression).toBe(0);
    expect(c.entries[0].note).toMatch(/did not run/);
  });

  it("limits v1-imported baselines to the checks v1 had", () => {
    const base = { audit: audit(["metadata", "indexability"], [{ code: "graph_incomplete", message: LEGACY_V1_NOTE }]), pages: [page("/", [rule("title", "metadata"), rule("canonical", "indexability")])], findings: [] };
    const head = {
      audit: audit(["metadata", "indexability"]),
      pages: [page("/", [rule("title", "metadata"), rule("canonical", "indexability")])],
      findings: [finding("canonical/cross-url", "/", { category: "indexability" }), finding("title/too-long", "/")],
    };
    const c = compareAudits(base, head);
    const kind = (code: string) => c.entries.find((e) => e.head?.ruleCode === code)?.kind;
    expect(kind("canonical/cross-url")).toBe("new"); // v1 never had this check
    expect(kind("title/too-long")).toBe("regression"); // v1 did check title length
  });

  it("does not resolve a finding whose page the later audit skipped", () => {
    const base = { audit: audit(["metadata"]), pages: [page("/", [rule("title", "metadata")]), page("/about", [rule("title", "metadata")])], findings: [finding("title/too-long", "/about")] };
    const head = { audit: audit(["metadata"]), pages: [page("/", [rule("title", "metadata")])], findings: [] };
    const c = compareAudits(base, head);
    expect(c.counts.resolved).toBe(0);
    expect(c.counts.not_rechecked).toBe(1);
  });
});

describe("groupIssues", () => {
  const row = (code: string, path: string, level = 3, siteId = "s1", task: { workflowStatus: string } | null = null) => {
    const f = finding(code, path, { priority: { level: level as 1, score: 0, severity: level <= 2 ? "high" : "low", reasons: [] } });
    return { fingerprint: f.fingerprint, siteId, finding: f, task };
  };

  it("collapses instances of one check on one site into a group with its affected pages", () => {
    const groups = groupIssues([row("images/missing-dimensions", "/b"), row("images/missing-dimensions", "/a"), row("images/missing-dimensions", "/a", 3, "s2"), row("title/missing", "/a", 1)]);
    expect(groups.map((g) => [g.siteId, g.ruleCode, g.instances.length])).toEqual([
      ["s1", "title/missing", 1],
      ["s1", "images/missing-dimensions", 2],
      ["s2", "images/missing-dimensions", 1],
    ]);
    expect(groups[1].pages).toEqual([`${O}/a`, `${O}/b`]);
  });

  it("takes the most urgent instance's priority and counts only active tasks", () => {
    const [g] = groupIssues([row("headings/skipped-level", "/a", 4, "s1", { workflowStatus: "resolved" }), row("headings/skipped-level", "/b", 2, "s1", { workflowStatus: "in_progress" })]);
    expect(g.priority).toBe(2);
    expect(g.severity).toBe("high");
    expect(g.withActiveTask).toBe(1);
  });
});
