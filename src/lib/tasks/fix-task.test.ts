import { describe, expect, it } from "vitest";
import { MemoryStore } from "../store/store";
import { runAudit, trackFinding, type Deps } from "../workflow/service";
import { fixTaskToMarkdown } from "./fix-task";

const deps: Deps = {
  store: new MemoryStore(),
  fetchLive: async () => {
    throw new Error("unused");
  },
  now: () => new Date("2026-10-23T10:00:00Z"),
  newId: (() => {
    let n = 0;
    return () => `id-${++n}`;
  })(),
};

describe("fixTaskToMarkdown", () => {
  it("includes evidence, recommendations, acceptance criteria and the sample label", async () => {
    const audit = await runAudit({ sample: true }, deps);
    const t = await trackFinding(audit.id, "title/too-long", deps);
    const md = fixTaskToMarkdown(t);
    expect(md).toContain("SAMPLE DATA");
    expect(md).toContain(t.finding.observed);
    for (const r of t.finding.recommendations) expect(md).toContain(r);
    for (const c of t.finding.acceptanceCriteria) expect(md).toContain(`- [ ] ${c.description}`);
    expect(md).toContain("```html");
  });

  it("omits the sample banner for live findings", async () => {
    const audit = await runAudit({ sample: true }, deps);
    const t = await trackFinding(audit.id, "title/too-long", deps);
    expect(fixTaskToMarkdown({ ...t, source: "live" })).not.toContain("SAMPLE DATA");
  });
});
