import { describe, expect, it } from "vitest";
import { diffLines, htmlLines, hunks } from "./line-diff";

const apply = (r: ReturnType<typeof diffLines>) => ({
  a: r.lines.filter((l) => l.op !== "add").map((l) => l.text),
  b: r.lines.filter((l) => l.op !== "del").map((l) => l.text),
});

describe("line diff", () => {
  it("splits HTML one tag per line", () => {
    expect(htmlLines('<html><head>\n  <title>T</title></head>  <body><div id="root"></div></body></html>')).toEqual(["<html>", "<head>", "<title>T</title>", "</head>", "<body>", '<div id="root">', "</div>", "</body>", "</html>"]);
  });

  it("finds the shortest edit and rebuilds both sides", () => {
    const a = ["a", "b", "c", "a", "b", "b", "a"];
    const b = ["c", "b", "a", "b", "a", "c"];
    const r = diffLines(a, b);
    expect(r.tooLarge).toBe(false);
    expect(apply(r)).toEqual({ a, b });
    // Myers' example: the shortest script has 5 edits.
    expect(r.added + r.removed).toBe(5);
  });

  it("numbers lines on each side and handles empty and identical inputs", () => {
    const r = diffLines(["<p>", "x", "</p>"], ["<p>", "y", "</p>", "<a>"]);
    expect(r.lines).toEqual([
      { op: "same", text: "<p>", a: 1, b: 1 },
      { op: "del", text: "x", a: 2, b: null },
      { op: "add", text: "y", a: null, b: 2 },
      { op: "same", text: "</p>", a: 3, b: 3 },
      { op: "add", text: "<a>", a: null, b: 4 },
    ]);
    expect(diffLines([], [])).toMatchObject({ lines: [], added: 0, removed: 0, tooLarge: false });
    expect(diffLines(["x"], ["x"])).toMatchObject({ added: 0, removed: 0 });
    expect(diffLines([], ["x", "y"])).toMatchObject({ added: 2, removed: 0 });
  });

  it("gives up past the edit limit with counts only", () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    expect(diffLines(a, b, 20)).toEqual({ lines: [], added: 50, removed: 50, tooLarge: true });
  });

  it("keeps context around changes and marks skipped runs", () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`);
    const b = [...a];
    b[10] = "changed";
    const h = hunks(diffLines(a, b).lines, 2);
    expect(h.map((l) => (l ? `${l.op}:${l.text}` : "…"))).toEqual(["same:l8", "same:l9", "del:l10", "add:changed", "same:l11", "same:l12", "…"]);
  });
});
