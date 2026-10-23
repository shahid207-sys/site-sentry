import { describe, expect, it } from "vitest";
import { runRules } from "../run";
import type { PageExpectations } from "../types";

const URL_ = "https://example.com/shoes";
const page = (head: string) => `<!doctype html><html><head><title>x</title>${head}</head><body></body></html>`;
const rule = (id: string, head: string, exp: PageExpectations = {}, headers: Record<string, string> = {}) =>
  runRules({ html: page(head), pageUrl: URL_, headers }, exp).find((r) => r.ruleId === id)!;

describe("canonical rule", () => {
  it("asks for configuration instead of guessing when no expected canonical is set", () => {
    const r = rule("canonical", `<link rel="canonical" href="https://other.example/">`);
    expect(r.status).toBe("needs_config");
    expect(r.findings).toEqual([]);
    expect(r.missingExpectations).toEqual(["canonicalUrl"]);
    expect(r.facts.canonicalResolved).toBe("https://other.example/"); // still shows what it saw
  });

  it("passes when the canonical matches the configured URL (relative hrefs resolved)", () => {
    expect(rule("canonical", `<link rel="canonical" href="/shoes">`, { canonicalUrl: URL_ }).status).toBe("pass");
  });

  it.each([
    ["missing", ``],
    ["wrong", `<link rel="canonical" href="https://example.com/shoes?utm=x">`],
    ["multiple", `<link rel="canonical" href="/shoes"><link rel="canonical" href="/boots">`],
  ])("fails when the canonical is %s", (_, head) => {
    const r = rule("canonical", head, { canonicalUrl: URL_ });
    expect(r.findings.map((f) => f.ruleCode)).toEqual(["canonical/expected-url"]);
    expect(r.findings[0].acceptanceCriteria.find((c) => c.id === "canonical.equals")?.params).toEqual({ expected: URL_ });
  });
});

describe("indexability rule", () => {
  it("asks for configuration instead of guessing when intended indexability is not set", () => {
    const r = rule("indexability", `<meta name="robots" content="noindex">`);
    expect(r.status).toBe("needs_config");
    expect(r.findings).toEqual([]);
    expect(r.missingExpectations).toEqual(["indexability"]);
    expect(r.facts.metaNoindex).toBe(true);
  });

  it("flags noindex in meta or header when the page should be indexed", () => {
    expect(rule("indexability", `<meta name="robots" content="noindex, follow">`, { indexability: "index" }).findings[0].ruleCode).toBe(
      "indexability/unexpected-noindex",
    );
    expect(rule("indexability", ``, { indexability: "index" }, { "x-robots-tag": "none" }).status).toBe("fail");
    expect(rule("indexability", `<meta name="googlebot" content="NOINDEX">`, { indexability: "index" }).status).toBe("fail");
  });

  it("passes an indexable page that should be indexed", () => {
    expect(rule("indexability", `<meta name="robots" content="index, follow">`, { indexability: "index" }).status).toBe("pass");
  });

  it("flags a page that should be noindex but is not", () => {
    const r = rule("indexability", ``, { indexability: "noindex" });
    expect(r.findings.map((f) => f.ruleCode)).toEqual(["indexability/missing-noindex"]);
    expect(rule("indexability", ``, { indexability: "noindex" }, { "x-robots-tag": "noindex" }).status).toBe("pass");
  });
});
