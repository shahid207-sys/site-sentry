import { describe, expect, it } from "vitest";
import { altText, fmtBytes, headTagText, readSnapshot, stateWords } from "./snapshot";

describe("readSnapshot", () => {
  it("returns null without a snapshot", () => {
    expect(readSnapshot(null)).toBeNull();
  });

  it("reads a full row and sorts headers", () => {
    const s = readSnapshot({
      final_url: "https://x.com/",
      status_code: 200,
      headers: { "x-b": "2", "content-type": "text/html" },
      redirect_chain: [{ url: "http://x.com/", status: 301 }, { nope: 1 }],
      robots: { directives: [{ source: "meta", agent: "robots", directives: ["noindex"] }], noindex: { meta: true, header: false }, nofollow: { meta: false, header: false } },
      canonicals: [{ href: "/", resolved: "https://x.com/", location: "body", absolute: false }],
      outline: [{ level: 1, text: "Hi" }, { level: 9, text: "bad" }],
      images: [{ src: "a.png", alt: null }, { src: "b.png", alt: "" }, { src: "c.png", alt: "C", width: 100 }],
      json_ld: [{ raw: "{", parsed: null, error: "Unexpected end of JSON input" }],
      timings: { fetchMs: 120, extractMs: 4 },
      fetched_at: "2026-10-01T00:00:00.000Z",
      blob_status: "stored",
    })!;
    expect(s.extracted).toBe(true);
    expect(s.headers.map(([k]) => k)).toEqual(["content-type", "x-b"]);
    expect(s.redirectChain).toEqual([{ url: "http://x.com/", status: 301 }]);
    expect(s.robots?.noindex.meta).toBe(true);
    expect(s.canonicals[0].location).toBe("body");
    expect(s.outline).toEqual([{ level: 1, text: "Hi" }]);
    expect(s.images.map((i) => i.alt)).toEqual([null, "", "C"]);
    expect(s.images[2].width).toBe("100");
    expect(s.jsonLd[0].error).toMatch(/Unexpected/);
    expect(s.timings).toEqual({ fetchMs: 120, extractMs: 4 });
  });

  it("marks a snapshot without an extracted HTML body and tolerates missing fields", () => {
    const s = readSnapshot({ final_url: "https://x.com/file.pdf", status_code: 200, robots: null, head: "not a list" })!;
    expect(s.extracted).toBe(false);
    expect(s.head).toEqual([]);
    expect(s.titles).toEqual([]);
    expect(s.language).toBeNull();
    expect(s.timings).toBeNull();
    expect(s.truncated).toBe(false);
  });
});

describe("display helpers", () => {
  it("writes head tags as text", () => {
    expect(headTagText({ tag: "meta", attrs: { name: "robots", content: 'a"b' } })).toBe('<meta name="robots" content="a&quot;b">');
    expect(headTagText({ tag: "title", attrs: {}, text: "Home" })).toBe("<title>Home</title>");
  });
  it("tells absent alt from empty alt", () => {
    expect(altText(null).kind).toBe("absent");
    expect(altText("").kind).toBe("empty");
    expect(altText(" ").kind).toBe("empty");
    expect(altText("Logo")).toEqual({ kind: "text", label: "Logo" });
  });
  it("formats bytes", () => {
    expect(fmtBytes(null)).toBe("—");
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2.0 KB");
    expect(fmtBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
  it("explains every crawler state, and unknown ones generically", () => {
    expect(stateWords("blocked_robots")).toMatch(/robots\.txt/);
    expect(stateWords("something_new")).toMatch(/something new/);
  });
});
