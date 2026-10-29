import { describe, expect, it } from "vitest";
import type { UrlFacts } from "../rules/contract";
import { finding } from "../rules/contract";
import { groupPriority, occurrenceOf, reachBasis, reachPagesOf } from "./occurrences";
import { priorityOf, priorityScore, reach } from "./priority";

describe("priority", () => {
  it("reach is ln(1 + affected) / ln(1 + indexable), clamped", () => {
    expect(reach(1, 1000)).toBeCloseTo(Math.log(2) / Math.log(1001), 10);
    expect(reach(100, 1000)).toBeCloseTo(0.668, 3); // ln 101 / ln 1001 = 4.6151 / 6.9088
    expect(reach(1000, 1000)).toBe(1);
    expect(reach(5000, 1000)).toBe(1);
    expect(reach(0, 1000)).toBe(0);
    expect(reach(3, 0)).toBe(0);
  });

  it("score = impact × reach × confidence weight, banded (the published worked example)", () => {
    const r = reach(100, 1000);
    expect(priorityScore(4, r, "verified")).toBeCloseTo(2.67, 2);
    expect(priorityOf(priorityScore(4, r, "verified"))).toBe("high");
    expect(priorityScore(4, r, "heuristic")).toBeCloseTo(1.6032, 3);
    expect(priorityOf(priorityScore(4, r, "heuristic"))).toBe("medium");
    expect(priorityOf(priorityScore(5, 1, "verified"))).toBe("critical");
    expect(priorityOf(priorityScore(5, 1, "advisory"))).toBe("medium");
    expect(priorityOf(0.49)).toBe("info");
    expect(priorityOf(0.5)).toBe("low");
  });
});

const page = (url: string, over: Partial<UrlFacts["page"] & object> = {}, status = 200): UrlFacts =>
  ({
    id: 1,
    url,
    state: "analysed",
    statusCode: status,
    redirectTarget: null,
    discoveredVia: ["link"],
    page: { noindex: false, canonical: null, title: null, description: null, h1: null, textHash: null, simhash: null, template: "T1", ...over },
  }) as UrlFacts;

describe("occurrences and reach pages", () => {
  const urls = [page("https://a.test/1"), page("https://a.test/2"), page("https://a.test/no", { noindex: true }), { ...page("https://a.test/404"), page: null, statusCode: 404 } as UrlFacts];
  const basis = reachBasis({ urls, byUrl: new Map(urls.map((u) => [u.url, u])) });
  const R = { id: "X-1", version: 1, confidence: "verified" as const };

  it("counts indexable pages only, URLs that are not pages once, evidence page counts, and site-wide subjects", () => {
    expect(basis.indexable).toBe(2);
    expect(reachPagesOf(finding(R, "https://a.test/1", "m"), basis)).toBe(1);
    expect(reachPagesOf(finding(R, "https://a.test/no", "m"), basis)).toBe(0);
    expect(reachPagesOf(finding(R, "https://a.test/404", "m"), basis)).toBe(1);
    expect(reachPagesOf(finding(R, "https://cdn.test/img.png", "m", { pages: 7 }), basis)).toBe(2); // capped at indexable
    expect(reachPagesOf(finding(R, "https://a.test/robots.txt", "m"), basis)).toBeNull();
  });

  it("an occurrence carries the page's template and a fingerprint independent of message and counts", () => {
    const a = occurrenceOf(undefined, finding(R, "https://a.test/1", "one", { count: 1 }), basis);
    const b = occurrenceOf(undefined, finding(R, "https://a.test/1", "two", { count: 9 }), basis);
    expect(a.templateId).toBe("T1");
    expect(a.fingerprint).toBe(b.fingerprint);
    expect(occurrenceOf(undefined, finding(R, "https://a.test/1", "x", { groupKey: "Product" }), basis).fingerprint).not.toBe(a.fingerprint);
  });

  it("group priority: a site-wide subject reaches every indexable page; no issue, no reach", () => {
    const rule = { impact: 4 as const, confidence: "verified" as const, category: "indexability" as const };
    expect(groupPriority(rule, { ruleId: "X", affectedUrls: 1, inconclusiveUrls: 0, affectedPages: null }, 2)).toMatchObject({ affectedPages: 2, reach: 1, score: 4, priority: "critical" });
    expect(groupPriority(rule, { ruleId: "X", affectedUrls: 0, inconclusiveUrls: 3, affectedPages: 0 }, 2)).toMatchObject({ reach: 0, score: 0, priority: "info" });
  });
});
