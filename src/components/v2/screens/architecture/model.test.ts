import { describe, expect, it } from "vitest";
import type { UrlRow } from "@/lib/results/explore";
import { parseUrlFilter, REGEX_MAX } from "../urls/filter";
import { depthBars, depthProblems, directoryBreakdown, directoryFilter, directoryOf, directorySortKey, pagerankLeaders, splitUrl } from "./model";

const row = (url: string, over: Partial<UrlRow> = {}): UrlRow => ({
  url,
  state: "analysed",
  reason: null,
  status: 200,
  contentType: "text/html; charset=utf-8",
  depth: 1,
  linkDepth: 1,
  inbound: 1,
  pagerank: null,
  templateId: null,
  redirectTarget: null,
  discoveredVia: ["link"],
  elapsedMs: 10,
  bytes: 100,
  title: "t",
  description: "d",
  h1: "h",
  wordCount: 300,
  canonical: null,
  noindex: false,
  openIssues: 0,
  ...over,
});

describe("depthBars", () => {
  it("is empty for no rows", () => {
    expect(depthBars([])).toEqual([]);
  });
  it("fills gaps, sums duplicates and puts the sitemap-only bucket last", () => {
    const bars = depthBars([
      { depth: null, urls: 4, answered: 1 },
      { depth: 0, urls: 1, answered: 1 },
      { depth: 3, urls: 5, answered: 2 },
      { depth: 3, urls: 1, answered: 1 },
    ]);
    expect(bars.map((b) => [b.label, b.urls, b.answered, b.notAnswered])).toEqual([
      ["0", 1, 1, 0],
      ["1", 0, 0, 0],
      ["2", 0, 0, 0],
      ["3", 6, 3, 3],
      ["Sitemaps only", 4, 1, 3],
    ]);
  });
  it("keeps only the sitemap bucket when nothing has a link depth", () => {
    expect(depthBars([{ depth: null, urls: 2, answered: 2 }]).map((b) => b.depth)).toEqual([null]);
  });
  it("drops an empty sitemap bucket", () => {
    expect(depthBars([{ depth: 0, urls: 1, answered: 1 }, { depth: null, urls: 0, answered: 0 }]).map((b) => b.depth)).toEqual([0]);
  });
});

describe("splitUrl / directoryOf", () => {
  it("reads host and path, dropping query and fragment", () => {
    expect(splitUrl("https://Example.com:8080/a/b?x=/c#d")).toEqual({ host: "example.com:8080", path: "/a/b" });
    expect(splitUrl("https://example.com?q=1")).toEqual({ host: "example.com", path: "/" });
    expect(splitUrl("not a url")).toBeNull();
  });
  it("treats pages directly under / as the root folder", () => {
    expect(directoryOf("/")).toBe("/");
    expect(directoryOf("/about")).toBe("/");
    expect(directoryOf("/contact.html")).toBe("/");
    expect(directoryOf("/blog/")).toBe("/blog/");
    expect(directoryOf("/blog/post")).toBe("/blog/");
    expect(directoryOf("/blog/a/b/")).toBe("/blog/");
    expect(directoryOf("//x")).toBe("//");
  });
});

describe("directoryBreakdown", () => {
  it("is empty for no rows", () => {
    expect(directoryBreakdown([], "example.com")).toEqual({ rows: [], otherHosts: 0 });
  });

  const rows = [
    row("https://example.com/", { openIssues: 2, wordCount: 100, inbound: 10 }),
    row("https://example.com/?utm=1", { openIssues: 0, wordCount: null, inbound: null }),
    row("https://example.com/about", { openIssues: 1, wordCount: 300, inbound: 2 }),
    row("https://example.com/blog/", { openIssues: 1, wordCount: 200, inbound: 4 }),
    row("https://example.com/blog/post-1", { openIssues: 3, wordCount: 400, inbound: 2 }),
    row("https://example.com/blog/post-2?page=2", { state: "budget_exhausted", wordCount: null, inbound: null }),
    row("https://example.com/Blog/Upper", { openIssues: 0, wordCount: 600, inbound: 0 }),
    row("https://example.com/blogger/x", { openIssues: 0 }),
    row("https://example.com/tags/blog/x", { openIssues: 0 }),
    row("https://other.org/blog/x", { state: "out_of_scope" }),
  ];

  it("groups by first folder, case-insensitively, and counts other hosts apart", () => {
    const { rows: dirs, otherHosts } = directoryBreakdown(rows, "Example.com");
    expect(otherHosts).toBe(1);
    const blog = dirs.find((d) => d.dir === "/blog/")!;
    expect(blog).toMatchObject({ urls: 4, answered: 3, openIssues: 4, issuesPerUrl: 1 });
    expect(blog.avgWords).toBe(400); // (200 + 400 + 600) / 3; the unfetched row has no snapshot
    expect(blog.avgInbound).toBe(2); // (4 + 2 + 0) / 3
    const root = dirs.find((d) => d.dir === "/")!;
    expect(root).toMatchObject({ urls: 3, answered: 3, openIssues: 3, avgWords: 200, avgInbound: 6 });
    expect(dirs.map((d) => d.dir)).toEqual(["/blog/", "/", "/blogger/", "/tags/"]);
  });

  it("gives every folder an explorer filter that matches exactly its URLs", () => {
    const { rows: dirs } = directoryBreakdown(rows, "example.com");
    for (const d of dirs) {
      expect(d.exactFilter).toBe(true);
      const m = parseUrlFilter(d.q);
      expect(m.error).toBeNull();
      expect(rows.filter((r) => m.test!(r.url)).length).toBe(d.urls);
    }
  });

  it("leaves avg words and inbound null when nothing measured them", () => {
    const { rows: dirs } = directoryBreakdown([row("https://example.com/x/", { wordCount: null, inbound: null })], "example.com");
    expect(dirs[0]).toMatchObject({ avgWords: null, avgInbound: null });
  });

  it("sorts by column keys", () => {
    const { rows: dirs } = directoryBreakdown(rows, "example.com");
    expect(directorySortKey(dirs[0], "dir")).toBe("/blog/");
    expect(directorySortKey(dirs[0], "nope")).toBeNull();
  });
});

describe("directoryFilter", () => {
  it("escapes regex characters in host and folder", () => {
    const f = directoryFilter("ex.com", "/a+b(1)/");
    const m = parseUrlFilter(f.q);
    expect(m.test!("https://ex.com/a+b(1)/page")).toBe(true);
    expect(m.test!("https://exxcom/a+b(1)/page")).toBe(false);
    expect(m.test!("https://ex.com/aab1/page")).toBe(false);
  });
  it("falls back to a substring when the regex would be too long", () => {
    const dir = `/${"x".repeat(REGEX_MAX)}/`;
    expect(directoryFilter("ex.com", dir)).toEqual({ q: `ex.com${dir}`, exact: false });
  });
});

describe("pagerankLeaders", () => {
  it("ranks by PageRank, then inbound, then URL, skipping unscored URLs", () => {
    const top = pagerankLeaders(
      [
        row("https://e.com/c", { pagerank: 1.5, inbound: 1 }),
        row("https://e.com/a", { pagerank: 2 }),
        row("https://e.com/b", { pagerank: 1.5, inbound: 9 }),
        row("https://e.com/d", { pagerank: null }),
      ],
      2,
    );
    expect(top.map((r) => r.url)).toEqual(["https://e.com/a", "https://e.com/b"]);
    expect(pagerankLeaders([])).toEqual([]);
  });
});

describe("depthProblems", () => {
  it("counts HTML pages only, deepest first, and unreachable ones apart", () => {
    const p = depthProblems([
      row("https://e.com/a", { linkDepth: 5 }),
      row("https://e.com/b", { linkDepth: 9 }),
      row("https://e.com/c", { linkDepth: 4 }),
      row("https://e.com/d", { linkDepth: null }),
      row("https://e.com/e.pdf", { linkDepth: null, contentType: "application/pdf" }),
      row("https://e.com/f", { linkDepth: null, state: "redirected" }),
    ]);
    expect(p.pages).toBe(4);
    expect(p.deep.map((r) => r.url)).toEqual(["https://e.com/b", "https://e.com/a"]);
    expect(p.unreachable.map((r) => r.url)).toEqual(["https://e.com/d"]);
  });
});
