import { describe, expect, it } from "vitest";
import type { UrlRow } from "@/lib/results/explore";
import { DEFAULT_COLS, PRESETS, exportValue, formatCols, parseCols, presetOf, sortKey } from "./columns";
import { csvCell, toCsv, urlRowsCsv } from "./csv";
import { REGEX_MAX, applyFilters, parseUrlFilter, statusClass, templateCounts, type UrlFilters } from "./filter";

const row = (o: Partial<UrlRow>): UrlRow => ({
  url: "https://example.com/",
  state: "fetched",
  reason: "HTTP 200",
  status: 200,
  contentType: "text/html",
  depth: 0,
  linkDepth: 0,
  inbound: 0,
  pagerank: null,
  templateId: null,
  redirectTarget: null,
  discoveredVia: ["seed"],
  elapsedMs: 100,
  bytes: 1000,
  title: null,
  description: null,
  h1: null,
  wordCount: null,
  canonical: null,
  noindex: false,
  openIssues: 0,
  ...o,
});

const none: UrlFilters = { match: null, state: null, status: null, noindex: null, issues: null, template: null };

describe("csvCell", () => {
  it("leaves plain values alone and writes null as empty", () => {
    expect(csvCell("abc")).toBe("abc");
    expect(csvCell(42)).toBe("42");
    expect(csvCell(null)).toBe("");
    expect(csvCell(undefined)).toBe("");
  });
  it("quotes commas, quotes and line breaks (RFC 4180)", () => {
    expect(csvCell("a,b")).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell("one\ntwo")).toBe('"one\ntwo"');
    expect(csvCell("one\r\ntwo")).toBe('"one\r\ntwo"');
  });
  it("prefixes text a spreadsheet would run as a formula", () => {
    expect(csvCell("=HYPERLINK(1)")).toBe("'=HYPERLINK(1)");
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("-1")).toBe("'-1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("\tx")).toBe("'\tx");
    // Guard first, then quote: the apostrophe sits inside the quotes.
    expect(csvCell('=1,"2"')).toBe(`"'=1,""2"""`);
  });
  it("does not touch numbers", () => {
    expect(csvCell(-3)).toBe("-3");
  });
});

describe("toCsv / urlRowsCsv", () => {
  it("starts with a BOM and ends every row with CRLF", () => {
    expect(toCsv(["a", "b"], [[1, null]])).toBe("﻿a,b\r\n1,\r\n");
  });
  it("exports every field with the URL first", () => {
    const csv = urlRowsCsv([row({ title: "Hello, world", discoveredVia: ["link", "sitemap"], noindex: true })]);
    const [header, data] = csv.slice(1).split("\r\n");
    expect(header.split(",")[0]).toBe("URL");
    expect(header.split(",")).toHaveLength(21);
    expect(data).toContain('"Hello, world"');
    expect(data).toContain("link; sitemap");
    expect(data).toContain(",yes,");
  });
});

describe("parseUrlFilter", () => {
  it("matches text case-insensitively", () => {
    const m = parseUrlFilter("Blog");
    expect(m.error).toBeNull();
    expect(m.test!("https://x.com/blog/a")).toBe(true);
    expect(m.test!("https://x.com/shop")).toBe(false);
  });
  it("matches a regex after re:", () => {
    const m = parseUrlFilter("re:/p/\\d+$");
    expect(m.test!("https://x.com/p/12")).toBe(true);
    expect(m.test!("https://x.com/p/12/a")).toBe(false);
  });
  it("reports an invalid regex instead of filtering everything out", () => {
    const m = parseUrlFilter("re:(unclosed");
    expect(m.test).toBeNull();
    expect(m.error).toMatch(/Invalid regular expression/);
  });
  it("caps the regex length", () => {
    const m = parseUrlFilter("re:" + "a".repeat(REGEX_MAX + 1));
    expect(m.test).toBeNull();
    expect(m.error).toMatch(String(REGEX_MAX));
  });
  it("treats empty input and a bare re: as no filter", () => {
    expect(parseUrlFilter("  ")).toEqual({ test: null, error: null });
    expect(parseUrlFilter("re:")).toEqual({ test: null, error: null });
  });
});

describe("statusClass", () => {
  it("buckets statuses", () => {
    expect(statusClass(null)).toBe("none");
    expect(statusClass(204)).toBe("2xx");
    expect(statusClass(301)).toBe("3xx");
    expect(statusClass(404)).toBe("4xx");
    expect(statusClass(503)).toBe("5xx");
    expect(statusClass(101)).toBeNull();
  });
});

describe("applyFilters", () => {
  const rows = [
    row({ url: "https://x.com/a", state: "fetched", status: 200, openIssues: 2, templateId: "t1" }),
    row({ url: "https://x.com/b", state: "fetched", status: 404, noindex: true, templateId: "t1" }),
    row({ url: "https://x.com/c", state: "redirected", status: 301, redirectTarget: "https://x.com/a" }),
    row({ url: "https://x.com/d", state: "blocked_robots", status: null, reason: "Disallow: /d" }),
  ];
  it("counts states with every filter but the state one", () => {
    const r = applyFilters(rows, { ...none, state: "fetched" });
    expect(r.rows.map((x) => x.url)).toEqual(["https://x.com/a", "https://x.com/b"]);
    expect(r.stateCounts).toEqual([["fetched", 2], ["blocked_robots", 1], ["redirected", 1]]);
  });
  it("keeps a selected state chip at zero", () => {
    const r = applyFilters(rows, { ...none, state: "redirected", status: "2xx" });
    expect(r.rows).toEqual([]);
    expect(r.stateCounts).toContainEqual(["redirected", 0]);
  });
  it("filters by status class, open issues and template", () => {
    expect(applyFilters(rows, { ...none, status: "none" }).rows.map((x) => x.url)).toEqual(["https://x.com/d"]);
    expect(applyFilters(rows, { ...none, issues: "yes" }).rows.map((x) => x.url)).toEqual(["https://x.com/a"]);
    expect(applyFilters(rows, { ...none, template: "t1" }).rows).toHaveLength(2);
  });
  it("treats noindex as unknown on URLs that were not read", () => {
    expect(applyFilters(rows, { ...none, noindex: "yes" }).rows.map((x) => x.url)).toEqual(["https://x.com/b"]);
    expect(applyFilters(rows, { ...none, noindex: "no" }).rows.map((x) => x.url)).toEqual(["https://x.com/a"]);
  });
  it("applies the URL matcher", () => {
    expect(applyFilters(rows, { ...none, match: parseUrlFilter("re:/[cd]$").test }).rows).toHaveLength(2);
  });
  it("lists templates by URL count", () => {
    expect(templateCounts(rows)).toEqual([["t1", 2]]);
  });
});

describe("columns", () => {
  it("parses cols= in display order and drops unknown ids", () => {
    expect(parseCols("bytes,nope,state")).toEqual(["state", "bytes"]);
    expect(parseCols(null)).toEqual(DEFAULT_COLS);
    expect(parseCols("nope")).toEqual(DEFAULT_COLS);
  });
  it("keeps the default set out of the URL", () => {
    expect(formatCols(DEFAULT_COLS)).toBeNull();
    expect(formatCols(["bytes", "state"])).toBe("state,bytes");
  });
  it("recognises presets whatever the order", () => {
    expect(presetOf([...PRESETS.links.cols].reverse())).toBe("links");
    expect(presetOf(["state"])).toBeNull();
  });
  it("sorts text case-insensitively and lists by their joined value", () => {
    expect(sortKey(row({ title: "Abc" }), "title")).toBe("abc");
    expect(sortKey(row({ discoveredVia: [] }), "discoveredVia")).toBeNull();
    expect(sortKey(row({ noindex: true }), "noindex")).toBe(1);
    expect(sortKey(row({}), "unknown")).toBeNull();
  });
  it("exports booleans and lists as words", () => {
    expect(exportValue(row({ noindex: false }), "noindex")).toBe("no");
    // noindex of a URL that was never read is unknown: an empty cell, sorted with the nulls.
    expect(exportValue(row({ state: "blocked_robots", status: null }), "noindex")).toBeNull();
    expect(sortKey(row({ state: "redirected" }), "noindex")).toBeNull();
    expect(exportValue(row({ discoveredVia: ["a", "b"] }), "discoveredVia")).toBe("a; b");
    expect(exportValue(row({ pagerank: null }), "pagerank")).toBeNull();
  });
});
