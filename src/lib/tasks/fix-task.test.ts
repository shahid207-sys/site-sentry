import { describe, expect, it } from "vitest";
import { auditSample } from "../audit/audit";
import { createFixTask, fixTaskToMarkdown } from "./fix-task";

describe("fix tasks", () => {
  const audit = auditSample();
  const finding = audit.rules[0].findings[0];

  it("creates a stable id per page and rule", () => {
    expect(createFixTask(audit, finding).id).toBe(createFixTask(audit, finding).id);
    expect(createFixTask(audit, finding).id).toBe(`${audit.finalUrl}::${finding.ruleId}`);
  });

  it("renders markdown with evidence and labels sample data", () => {
    const md = fixTaskToMarkdown(createFixTask(audit, finding));
    expect(md).toContain("SAMPLE DATA");
    expect(md).toContain(finding.evidence.observed);
    expect(md).toContain(finding.recommendation);
    expect(md).toContain("```html");
  });

  it("omits the sample banner for live audits", () => {
    const md = fixTaskToMarkdown(createFixTask({ ...audit, source: "live" }, finding));
    expect(md).not.toContain("SAMPLE DATA");
  });
});
