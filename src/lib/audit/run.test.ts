import { describe, expect, it } from "vitest";
import { SAMPLE_HTML } from "../sample/sample-page";
import { auditSample } from "./audit";
import { runRules } from "./run";

describe("runRules", () => {
  it("is deterministic for the same input", () => {
    expect(runRules(SAMPLE_HTML)).toEqual(runRules(SAMPLE_HTML));
  });

  it("finds the problems deliberately planted in the sample fixture", () => {
    const [title] = runRules(SAMPLE_HTML);
    expect(title.passed).toBe(false);
    // Two head titles (SVG <title> ignored), and the first one is too long.
    expect(title.findings.map((f) => f.ruleId)).toEqual(["title/multiple", "title/too-long"]);
  });
});

describe("auditSample", () => {
  it("is labelled as sample data, never live", () => {
    const result = auditSample();
    expect(result.source).toBe("sample");
    expect(result.finalUrl).toMatch(/\.invalid\//);
  });
});
