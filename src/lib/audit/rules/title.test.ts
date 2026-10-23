import { describe, expect, it } from "vitest";
import { parseHtml } from "../parse";
import { checkTitle, TITLE_MAX_CHARS, TITLE_MIN_CHARS } from "./title";

const page = (head: string, body = "") =>
  `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const ids = (html: string) => checkTitle(parseHtml(html)).findings.map((f) => f.ruleId);

const GOOD = "Trail Running Shoes for Every Terrain | Example"; // 47 chars

describe("checkTitle", () => {
  it("passes a single title of reasonable length", () => {
    const result = checkTitle(parseHtml(page(`<title>${GOOD}</title>`)));
    expect(result.passed).toBe(true);
    expect(result.findings).toEqual([]);
  });

  it("flags a missing title", () => {
    const result = checkTitle(parseHtml(page(`<meta charset="utf-8">`)));
    expect(result.passed).toBe(false);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ ruleId: "title/missing", severity: "high" });
  });

  it("flags an empty title", () => {
    expect(ids(page(`<title></title>`))).toEqual(["title/empty"]);
  });

  it("treats a whitespace-only title as empty", () => {
    expect(ids(page(`<title>  \n\t </title>`))).toEqual(["title/empty"]);
  });

  it("flags multiple titles and evaluates length on the first one", () => {
    const html = page(`<title>${GOOD}</title><title>Second</title>`);
    const result = checkTitle(parseHtml(html));
    expect(result.findings.map((f) => f.ruleId)).toEqual(["title/multiple"]);
    expect(result.findings[0].evidence.snippets).toHaveLength(2);
  });

  it("ignores <title> inside inline SVG", () => {
    expect(ids(page(`<title>${GOOD}</title>`, `<svg><title>Icon</title></svg>`))).toEqual([]);
    expect(ids(page("", `<svg><title>Icon</title></svg>`))).toEqual(["title/missing"]);
  });

  it("flags a title longer than the heuristic max", () => {
    const long = "x".repeat(TITLE_MAX_CHARS + 1);
    const result = checkTitle(parseHtml(page(`<title>${long}</title>`)));
    expect(result.findings[0]).toMatchObject({ ruleId: "title/too-long", severity: "low" });
    expect(result.findings[0].evidence.observed).toContain(`${TITLE_MAX_CHARS + 1} chars`);
  });

  it("does not flag a title exactly at the boundaries", () => {
    expect(ids(page(`<title>${"x".repeat(TITLE_MAX_CHARS)}</title>`))).toEqual([]);
    expect(ids(page(`<title>${"x".repeat(TITLE_MIN_CHARS)}</title>`))).toEqual([]);
  });

  it("flags a title shorter than the heuristic min", () => {
    expect(ids(page(`<title>Home</title>`))).toEqual(["title/too-short"]);
  });

  it("collapses internal whitespace before measuring", () => {
    const spaced = GOOD.split(" ").join("     \n ");
    expect(ids(page(`<title>${spaced}</title>`))).toEqual([]);
  });

  it("decodes entities before measuring", () => {
    const result = checkTitle(parseHtml(page(`<title>Shoes &amp; Boots</title>`)));
    expect(result.findings[0].evidence.observed).toContain(`"Shoes & Boots" (13 chars)`);
  });

  it("includes the raw HTML as evidence", () => {
    const result = checkTitle(parseHtml(page(`<title>Home</title>`)));
    expect(result.findings[0].evidence.snippets).toEqual(["<title>Home</title>"]);
  });
});
