import { describe, expect, it } from "vitest";
import { RULE_TITLES } from "../rules/titles";
import { CHECKLIST, checklistRows } from "./checklist";

const row = (label: string, ...args: Parameters<typeof checklistRows>) => checklistRows(...args).find((x) => x.label === label)!;
const FAVICON = "Favicon"; // one rule: META-019
const VIEWPORT = "Mobile viewport"; // META-013, META-014
const ran = (ruleId: string, evaluated = 5) => ({ ruleId, status: "ran", evaluated });
const group = (ruleId: string, priority: "critical" | "high" | "medium" | "low" | "info", affectedUrls = 2, inconclusiveUrls = 0) => ({ ruleId, priority, affectedUrls, inconclusiveUrls });

describe("checklistRows", () => {
  it("names only rules that exist", () => {
    for (const c of CHECKLIST) for (const id of c.rules) expect(RULE_TITLES[id], id).toBeTruthy();
  });

  it("passes only when every rule ran on something and found nothing", () => {
    expect(row(VIEWPORT, [], [ran("META-013"), ran("META-014")]).status).toBe("Pass");
  });

  it("never passes a rule that did not run", () => {
    expect(row(VIEWPORT, [], [ran("META-013"), { ruleId: "META-014", status: "needs_config", evaluated: 0 }]).status).toBe("Not checked");
    expect(row(VIEWPORT, [], [ran("META-013")]).status).toBe("Not checked");
    expect(row(FAVICON, [], [{ ruleId: "META-019", status: "error", evaluated: 0 }]).status).toBe("Not checked");
  });

  it("does not pass rules that ran with nothing to evaluate", () => {
    expect(row(FAVICON, [], [ran("META-019", 0)]).status).toBe("Not checked");
  });

  it("fails on a medium priority or above, and warns on low, info or inconclusive", () => {
    const runs = [ran("META-013"), ran("META-014")];
    expect(row(VIEWPORT, [group("META-013", "medium")], runs).status).toBe("Fail");
    expect(row(VIEWPORT, [group("META-013", "low")], runs).status).toBe("Warning");
    expect(row(VIEWPORT, [group("META-013", "critical", 0, 3)], runs).status).toBe("Warning");
  });

  it("reports a found issue even if another rule of the row did not run", () => {
    expect(row(VIEWPORT, [group("META-013", "high")], [ran("META-013")]).status).toBe("Fail");
  });

  it("does not pass a row when any of its rules had nothing to evaluate", () => {
    expect(row(VIEWPORT, [], [ran("META-013"), ran("META-014", 0)]).status).toBe("Not checked");
    expect(row("External links", [], [ran("LNK-010", 0)]).status).toBe("Not checked");
    expect(row("External links", [], [ran("LNK-010", 40)]).status).toBe("Pass");
  });
});
