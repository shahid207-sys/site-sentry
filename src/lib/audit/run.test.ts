import { describe, expect, it } from "vitest";
import { SAMPLE_HTML_BROKEN, SAMPLE_HTML_FIXED, SAMPLE_URL } from "../sample/sample-page";
import { evaluateCriteria } from "./rule";
import { CRITERION_EVALUATORS, RULES, runRules } from "./run";
import type { Facts, PageExpectations } from "./types";

const sample = (html: string, exp: PageExpectations = {}) => runRules({ html, pageUrl: SAMPLE_URL }, exp);
const FULL_EXP: PageExpectations = { canonicalUrl: SAMPLE_URL, indexability: "index" };

describe("runRules", () => {
  it("is deterministic for the same input", () => {
    expect(sample(SAMPLE_HTML_BROKEN, FULL_EXP)).toEqual(sample(SAMPLE_HTML_BROKEN, FULL_EXP));
  });

  it("finds the problems planted in the broken sample, and none in the fixed one", () => {
    const codes = (html: string) => sample(html, FULL_EXP).flatMap((r) => r.findings.map((f) => f.ruleCode));
    expect(codes(SAMPLE_HTML_BROKEN)).toEqual([
      "title/multiple",
      "title/too-long",
      "canonical/expected-url",
      "indexability/unexpected-noindex",
    ]);
    expect(codes(SAMPLE_HTML_FIXED)).toEqual([]);
  });

  it("stores every required field on each finding", () => {
    const findings = sample(SAMPLE_HTML_BROKEN, FULL_EXP).flatMap((r) => r.findings);
    for (const f of findings) {
      expect(f.ruleCode).toMatch(/^[a-z]+\/[a-z-]+$/);
      expect(f.pageUrl).toBe(SAMPLE_URL);
      expect(f.observed).not.toBe("");
      expect(f.expected).not.toBe("");
      expect(["high", "medium", "low"]).toContain(f.severity);
      expect(f.evidence.snippets.length).toBeGreaterThan(0);
      expect(Object.keys(f.evidence.facts).length).toBeGreaterThan(0);
      expect(f.recommendations.length).toBeGreaterThan(0);
      expect(f.acceptanceCriteria.length).toBeGreaterThan(0);
      for (const c of f.acceptanceCriteria) expect(CRITERION_EVALUATORS[c.id]).toBeDefined();
    }
  });
});

// Detection and verification must agree: if a check fires on some facts, those same facts
// must fail at least one of its acceptance criteria — otherwise a finding could "resolve" unchanged.
describe("detection/acceptance invariant", () => {
  const factSets: Facts[] = [];
  const titles = [0, 1, 2].flatMap((count) =>
    [null, "", "x".repeat(10), "x".repeat(30), "x".repeat(60), "x".repeat(61)].map((t) => ({
      titleCount: count,
      titleText: count === 0 ? null : t,
      titleLength: count === 0 || t === null ? null : t.length,
    })),
  );
  const canon = [0, 1, 2].flatMap((count) =>
    [null, SAMPLE_URL, "https://other.example/"].map((u) => ({ canonicalCount: count, canonicalHref: u, canonicalResolved: count ? u : null })),
  );
  const robots = [false, true].flatMap((m) =>
    [false, true].map((h) => ({ metaRobots: m ? "noindex" : null, xRobotsTag: h ? "noindex" : null, metaNoindex: m, headerNoindex: h })),
  );
  for (const t of titles) for (const c of canon) for (const r of robots) factSets.push({ ...t, ...c, ...r });

  const exps: PageExpectations[] = [
    { canonicalUrl: SAMPLE_URL, indexability: "index" },
    { canonicalUrl: SAMPLE_URL, indexability: "noindex" },
  ];

  for (const rule of RULES) {
    for (const check of rule.checks) {
      it(`${check.code}: detection implies a failing criterion`, () => {
        let fired = 0;
        for (const exp of exps) {
          for (const facts of factSets) {
            if (!check.detect(facts, exp)) continue;
            fired++;
            const { results } = evaluateCriteria(check.criteria(exp), facts, CRITERION_EVALUATORS);
            expect(results.some((r) => !r.passed), JSON.stringify({ facts, exp })).toBe(true);
          }
        }
        expect(fired).toBeGreaterThan(0);
      });
    }
  }
});
