import { describe, expect, it } from "vitest";
import { failureText } from "./failure";

describe("failureText", () => {
  it("labels a refused scope rule with its code, so the reason is visible on the audit", () => {
    expect(failureText({ code: "scope_rule_invalid", message: 'Include rule 1 "(a+)+$" is refused: …' }, "x")).toEqual({
      label: "scope_rule_invalid",
      message: 'Include rule 1 "(a+)+$" is refused: …',
    });
  });

  it("shows other errors by message only, and the fallback when there is none", () => {
    expect(failureText({ code: "INTERNAL", message: "The crawl stopped with an error: boom" }, "x")).toEqual({ label: null, message: "The crawl stopped with an error: boom" });
    expect(failureText(undefined, "Unknown error.")).toEqual({ label: null, message: "Unknown error." });
  });
});
