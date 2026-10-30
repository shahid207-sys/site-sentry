import { describe, expect, it } from "vitest";
import type { IssueRow, UrlRow } from "@/lib/results/explore";
import { groupDuplicates, isContentPage, metaGaps, pagesIn, parseDuplicateKind, thinPages, thinThreshold, wordBuckets } from "./model";

const row = (url: string, over: Partial<UrlRow> = {}): UrlRow => ({
  url,
  state: "analysed",
  reason: null,
  status: 200,
  contentType: "text/html",
  depth: 1,
  linkDepth: 1,
  inbound: 1,
  pagerank: null,
  templateId: null,
  redirectTarget: null,
  discoveredVia: ["link"],
  elapsedMs: 10,
  bytes: 100,
  title: "Title",
  description: "Desc",
  h1: "H1",
  wordCount: 300,
  canonical: null,
  noindex: false,
  openIssues: 0,
  ...over,
});

const issue = (url: string, state: IssueRow["state"] = "new", message: string | null = null): IssueRow => ({
  fingerprint: `fp-${url}-${state}`,
  ruleId: "CNT-005",
  url,
  state,
  outcome: "issue",
  templateId: null,
  message,
  verified: false,
});

describe("groupDuplicates", () => {
  it("is empty for no clusters", () => {
    expect(groupDuplicates([])).toEqual({ title: [], description: [], content: [], near: [] });
  });
  it("sorts by size, de-duplicates URLs, drops singletons and unknown rules", () => {
    const g = groupDuplicates([
      { ruleId: "META-004", key: "B", urls: ["/1", "/2"] },
      { ruleId: "META-004", key: "A", urls: ["/3", "/4"] },
      { ruleId: "META-004", key: "C", urls: ["/5", "/6", "/7"] },
      { ruleId: "META-009", key: "d", urls: ["/1", "/1"] },
      { ruleId: "CNT-006", key: "hash", urls: ["/a", "/b"] },
      { ruleId: "CNT-007", key: "near-duplicate", urls: ["/x", "/y", "/z"] },
      { ruleId: "LNK-001", key: "?", urls: ["/a", "/b"] },
    ]);
    expect(g.title.map((c) => c.key)).toEqual(["C", "A", "B"]);
    expect(g.description).toEqual([]);
    expect(g.content).toHaveLength(1);
    expect(pagesIn(g.near)).toBe(3);
    expect(pagesIn(g.title)).toBe(7);
  });
  it("parses only known kinds", () => {
    expect(parseDuplicateKind("near")).toBe("near");
    expect(parseDuplicateKind("bogus")).toBeNull();
    expect(parseDuplicateKind(null)).toBeNull();
  });
});

describe("isContentPage / metaGaps", () => {
  it("counts only answered HTML 200 pages with a snapshot", () => {
    expect(isContentPage(row("/a"))).toBe(true);
    expect(isContentPage(row("/b", { status: 404 }))).toBe(false);
    expect(isContentPage(row("/c", { contentType: "application/pdf" }))).toBe(false);
    expect(isContentPage(row("/d", { state: "redirected" }))).toBe(false);
    expect(isContentPage(row("/e", { wordCount: null, title: null }))).toBe(false);
    expect(isContentPage(row("/f", { contentType: null }))).toBe(false);
  });
  it("tells a missing title from an empty one and treats an empty H1 as present", () => {
    const g = metaGaps([
      row("/1", { title: null, description: null, h1: null }),
      row("/2", { title: "  ", description: "", h1: "" }),
      row("/3"),
      row("/4", { title: null, status: 404 }),
    ]);
    expect(g).toEqual({ pages: 3, noTitle: 1, emptyTitle: 1, noDescription: 2, noH1: 1 });
  });
  it("is all zeros for no rows", () => {
    expect(metaGaps([])).toEqual({ pages: 0, noTitle: 0, emptyTitle: 0, noDescription: 0, noH1: 0 });
  });
});

describe("wordBuckets", () => {
  it("has the default edges and an open last bucket", () => {
    const b = wordBuckets([], null);
    expect(b.map((x) => x.label)).toEqual(["0–49", "50–99", "100–199", "200–299", "300–499", "500–999", "1,000–1,999", "2,000+"]);
    expect(b.every((x) => x.pages === 0 && !x.thin)).toBe(true);
  });
  it("adds the threshold as an edge and marks buckets under it as thin", () => {
    const b = wordBuckets([row("/a", { wordCount: 0 }), row("/b", { wordCount: 149 }), row("/c", { wordCount: 150 }), row("/d", { wordCount: 5000 }), row("/e", { wordCount: 20, status: 500 })], 150);
    expect(b.map((x) => [x.label, x.pages, x.thin])).toEqual([
      ["0–49", 1, true],
      ["50–99", 0, true],
      ["100–149", 1, true],
      ["150–199", 1, false],
      ["200–299", 0, false],
      ["300–499", 0, false],
      ["500–999", 0, false],
      ["1,000–1,999", 0, false],
      ["2,000+", 1, false],
    ]);
  });
  it("does not duplicate an edge equal to the threshold", () => {
    expect(wordBuckets([], 200).filter((x) => x.from === 200)).toHaveLength(1);
  });
});

describe("thinThreshold", () => {
  it("reads the finding message first, then the acceptance text", () => {
    expect(thinThreshold([null, "120 words of main content (threshold 250)."], "At least 200 words of main content")).toBe(250);
    expect(thinThreshold([null], "At least 200 words of main content, or the page is noindexed.")).toBe(200);
    expect(thinThreshold([], null)).toBeNull();
    expect(thinThreshold(["no number here"], "No number either")).toBeNull();
  });
});

describe("thinPages", () => {
  it("keeps open findings once per URL, fewest words first, unknown last", () => {
    const urls = [row("https://e.com/a", { wordCount: 80 }), row("https://e.com/b", { wordCount: 12 }), row("https://e.com/c", { wordCount: 80 })];
    const t = thinPages(
      [issue("https://e.com/a"), issue("https://e.com/a", "persistent"), issue("https://e.com/b", "regressed"), issue("https://e.com/c"), issue("https://e.com/gone", "not_rechecked"), issue("https://e.com/fixed", "resolved")],
      urls,
    );
    expect(t.map((x) => [x.url, x.wordCount])).toEqual([
      ["https://e.com/b", 12],
      ["https://e.com/a", 80],
      ["https://e.com/c", 80],
      ["https://e.com/gone", null],
    ]);
    expect(thinPages([], [])).toEqual([]);
  });
});
