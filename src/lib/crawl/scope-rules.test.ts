import { describe, expect, it } from "vitest";
import { MAX_RULE_LENGTH } from "./profiles";
import { compileRules, regexProblem } from "./scope-rules";

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

  it("compileRules throws on an unusable rule, so a worker never runs one", () => {
    const [[source, re]] = compileRules(["/blog/"]);
    expect(source).toBe("/blog/");
    expect(re.test("https://a.test/blog/x")).toBe(true);
    expect(() => compileRules(["/ok/", "(a+)+$"])).toThrow('Scope rule "(a+)+$" is unusable: Refused:');
  });
});
