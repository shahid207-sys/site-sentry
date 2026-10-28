import { describe, expect, it } from "vitest";
import { MAX_RULE_LENGTH } from "./profiles";
import { compileRules, MAX_MATCH_INPUT, regexProblem, ruleVerdict } from "./scope-rules";

describe("scope rule validation", () => {
  it("accepts ordinary include/exclude patterns", () => {
    for (const p of [String.raw`^https://a\.test/blog/`, "/blog/.*", String.raw`\?page=\d+$`, "/(en|fr)/products/[^/]+$"]) expect(regexProblem(p)).toBeNull();
  });

  it("rejects empty and invalid patterns", () => {
    expect(regexProblem("")).toBe("Empty pattern.");
    expect(regexProblem("(")).toMatch(/Unterminated group|Invalid regular expression/);
  });

  it("caps patterns at 200 characters", () => {
    expect(MAX_RULE_LENGTH).toBe(200);
    expect(regexProblem("a".repeat(200))).toBeNull();
    expect(regexProblem("a".repeat(201))).toBe("Longer than 200 characters.");
  });

  it("rejects the catastrophic (a+)+$ and other nested quantifiers", () => {
    for (const p of ["(a+)+$", "(x+x+)+y", "([a-z]+)*$", String.raw`^(\w+\s?)*$`, "(.*a){12}"]) {
      expect(regexProblem(p), p).toMatch(/^Refused: this pattern can take exponential time/);
    }
  });

  it("documents the known gap: overlapping alternation passes the star-height check", () => {
    expect(regexProblem("^(a|a)*$")).toBeNull();
  });

  it("documents the known false positive: an optional group around .* is refused, and the suggested rewrite passes", () => {
    expect(regexProblem("/(en/.*)?$")).toMatch(/^Refused: .*e\.g\. \(x\.\*\)\?\$ as \(\$\|x\)\.$/);
    expect(regexProblem("/($|en/)")).toBeNull();
  });

  it("never runs a rule on input longer than 2,048 characters (second ReDoS guard)", () => {
    expect(MAX_MATCH_INPUT).toBe(2_048);
    let runs = 0;
    const counting = new (class extends RegExp {
      test(s: string) {
        runs++;
        return super.test(s);
      }
    })("/blog/");
    const at = (n: number) => `https://a.test/blog/${"a".repeat(n - 20)}`;
    expect(at(2_048)).toHaveLength(2_048);
    expect(ruleVerdict(at(2_048), [["/blog/", counting]], [])).toBeNull();
    expect(runs).toBe(1);
    expect(ruleVerdict(at(2_049), [["/blog/", counting]], [["/x/", counting]])).toBe("Longer than 2048 characters; scope rules are not run on it.");
    expect(runs).toBe(1);
    expect(ruleVerdict(at(5_000), [], [])).toBeNull(); // no rules: nothing to guard
  });

  it("compileRules throws on an unusable rule, so a worker never runs one", () => {
    const [[source, re]] = compileRules(["/blog/"]);
    expect(source).toBe("/blog/");
    expect(re.test("https://a.test/blog/x")).toBe(true);
    expect(() => compileRules(["/ok/", "(a+)+$"], "Exclude")).toThrow('Exclude rule 2 "(a+)+$" is refused: Refused:');
    expect(() => compileRules(["(a+)+$"])).toThrow(expect.objectContaining({ code: "scope_rule_invalid", kind: "Include", index: 0 }));
  });
});
