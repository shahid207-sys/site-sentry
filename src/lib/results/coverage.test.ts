import { describe, expect, it } from "vitest";
import { coverageVerdict } from "./coverage";

const crawl = { status: "completed", budget: 1000, maxDepth: 10, robots: { outcome: "parsed" } };

describe("coverageVerdict", () => {
  it("is complete when every URL reached a final state and no budget cut applied", () => {
    expect(coverageVerdict({ analysed: 40, redirected: 3, non_html: 2 }, crawl)).toEqual({ verdict: "complete", reasons: [], notes: [] });
  });

  it("counts API and feed endpoints in a note, not as a gap", () => {
    const v = coverageVerdict({ analysed: 40 }, { ...crawl, apiEndpoints: { found: 801, fetched: 83 } });
    expect(v.verdict).toBe("complete");
    expect(v.notes).toEqual([expect.stringMatching(/^API\/feed endpoints: 801 \(83 fetched\)/)]);
    expect(coverageVerdict({ analysed: 40 }, { ...crawl, apiEndpoints: { found: 0, fetched: 0 } }).notes).toEqual([]);
  });

  it("names the budget, the depth limit and the failures with their counts", () => {
    const v = coverageVerdict({ analysed: 1000, budget_exhausted: 12, depth_exceeded: 1, failed_timeout: 2, failed_dns: 1 }, crawl);
    expect(v.verdict).toBe("partial");
    expect(v.reasons.map((r) => [r.code, r.urls])).toEqual([["budget", 12], ["depth", 1], ["failures", 3]]);
    expect(v.reasons[0].message).toBe("Budget reached: 12 URLs found but not fetched, because the 1,000-URL budget ran out.");
    expect(v.reasons[1].message).toContain("1 URL more than 10 clicks");
    expect(v.reasons[2].message).toContain("2 timed out, 1 DNS failure");
  });

  it("states URLs robots.txt disallows without calling the audit partial", () => {
    const v = coverageVerdict({ analysed: 5, blocked_robots: 3 }, crawl);
    expect(v.verdict).toBe("complete");
    expect(v.notes).toEqual(["robots.txt disallows 3 URLs, so they were not fetched."]);
  });

  it("is partial with the robots reason when robots.txt blocked the whole crawl", () => {
    const v = coverageVerdict({ blocked_robots: 4 }, { ...crawl, robots: { outcome: "disallow_all", reason: "robots.txt returned 503; treated as a full disallow." } });
    expect(v.verdict).toBe("partial");
    expect(v.reasons[0]).toMatchObject({ code: "robots", urls: 4 });
    expect(v.reasons[0].message).toContain("returned 503");
  });

  it("does not judge a crawl that has not finished, and never calls a cancelled or failed one complete", () => {
    expect(coverageVerdict({ queued: 9 }, { ...crawl, status: "running" }).verdict).toBe("running");
    expect(coverageVerdict({ analysed: 2 }, { ...crawl, status: "cancelled" }).verdict).toBe("partial");
    expect(coverageVerdict({ analysed: 2 }, { ...crawl, status: "failed" }).reasons[0].code).toBe("failed");
  });
});
