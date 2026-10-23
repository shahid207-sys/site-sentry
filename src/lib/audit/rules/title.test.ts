import { describe, expect, it } from "vitest";
import { runRules } from "../run";
import { TITLE_MAX_CHARS, TITLE_MIN_CHARS } from "./title";

const page = (head: string, body = "") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const title = (html: string) => runRules({ html, pageUrl: "https://example.com/p" }).find((r) => r.ruleId === "title")!;
const codes = (html: string) => title(html).findings.map((f) => f.ruleCode);

const GOOD = "Trail Running Shoes for Every Terrain | Example"; // 47 chars

describe("title rule", () => {
  it("passes a single title of reasonable length", () => {
    const r = title(page(`<title>${GOOD}</title>`));
    expect(r.status).toBe("pass");
    expect(r.findings).toEqual([]);
    expect(r.facts).toEqual({ titleCount: 1, titleText: GOOD, titleLength: 47 });
  });

  it("flags a missing title", () => {
    const r = title(page(`<meta charset="utf-8">`));
    expect(r.status).toBe("fail");
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({ ruleCode: "title/missing", severity: "high" });
  });

  it("flags an empty title", () => {
    expect(codes(page(`<title></title>`))).toEqual(["title/empty"]);
  });

  it("treats a whitespace-only title as empty", () => {
    expect(codes(page(`<title>  \n\t </title>`))).toEqual(["title/empty"]);
  });

  it("flags multiple titles and evaluates length on the first one", () => {
    const r = title(page(`<title>${GOOD}</title><title>Second</title>`));
    expect(r.findings.map((f) => f.ruleCode)).toEqual(["title/multiple"]);
    expect(r.findings[0].evidence.snippets).toHaveLength(2);
  });

  it("ignores <title> inside inline SVG", () => {
    expect(codes(page(`<title>${GOOD}</title>`, `<svg><title>Icon</title></svg>`))).toEqual([]);
    expect(codes(page("", `<svg><title>Icon</title></svg>`))).toEqual(["title/missing"]);
  });

  it("flags a title longer than the heuristic max, freezing the threshold in the criterion", () => {
    const long = "x".repeat(TITLE_MAX_CHARS + 1);
    const [f] = title(page(`<title>${long}</title>`)).findings;
    expect(f).toMatchObject({ ruleCode: "title/too-long", severity: "low" });
    expect(f.observed).toContain(`${TITLE_MAX_CHARS + 1} chars`);
    expect(f.acceptanceCriteria).toEqual([expect.objectContaining({ id: "title.max-length", params: { max: TITLE_MAX_CHARS } })]);
  });

  it("does not flag a title exactly at the boundaries", () => {
    expect(codes(page(`<title>${"x".repeat(TITLE_MAX_CHARS)}</title>`))).toEqual([]);
    expect(codes(page(`<title>${"x".repeat(TITLE_MIN_CHARS)}</title>`))).toEqual([]);
  });

  it("flags a title shorter than the heuristic min", () => {
    expect(codes(page(`<title>Home</title>`))).toEqual(["title/too-short"]);
  });

  it("collapses internal whitespace before measuring", () => {
    expect(codes(page(`<title>${GOOD.split(" ").join("     \n ")}</title>`))).toEqual([]);
  });

  it("decodes entities before measuring", () => {
    const [f] = title(page(`<title>Shoes &amp; Boots</title>`)).findings;
    expect(f.observed).toBe(`"Shoes & Boots" (13 chars)`);
  });

  it("includes the raw HTML as evidence", () => {
    const [f] = title(page(`<title>Home</title>`)).findings;
    expect(f.evidence.snippets).toEqual(["<title>Home</title>"]);
  });
});
