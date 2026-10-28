import { describe, expect, it } from "vitest";
import { parsePublicUrl } from "./public-url";

describe("parsePublicUrl", () => {
  it("adds https:// to a bare domain and drops the fragment", () => {
    expect(parsePublicUrl("  Example.com/blog#top ")).toEqual({ url: "https://example.com/blog" });
  });
  it("keeps an explicit http:// address", () => {
    expect(parsePublicUrl("http://example.org")).toEqual({ url: "http://example.org/" });
  });
  it.each(["", "not a url", "ftp://example.com", "javascript:alert(1)", "localhost:3000", "http://intranet", "https://printer.local", "https://user:pw@example.com"])("rejects %j", (v) => {
    expect(parsePublicUrl(v)).toHaveProperty("error");
  });
});
