import { describe, expect, it } from "vitest";
import type { Finding } from "./contract";
import { GROUP_SAMPLE, TemplateGroups } from "./group";
import { RULES } from "./registry";

const f = (url: string, groupKey: string, missing: string[], outcome: Finding["outcome"] = "issue"): Finding => ({
  ruleId: "SD-004",
  ruleVersion: 1,
  url,
  confidence: "heuristic",
  outcome,
  message: `${groupKey} lacks recommended ${missing.join(", ")}.`,
  evidence: { groupKey, type: groupKey, missing },
});

describe("TemplateGroups", () => {
  it("reports one finding per template and group key, at the first URL in sort order, with every page counted", () => {
    const g = new TemplateGroups();
    for (const n of [7, 3, 12, 1, 9, 5, 2]) g.add([f(`https://a.test/p/${n}`, "Product", n === 9 ? ["offers", "review"] : ["review"])], "tpl-product");
    const out = g.findings();
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://a.test/p/1");
    expect(out[0].evidence.pages).toBe(7);
    expect(out[0].evidence.missing).toEqual(["offers", "review"]);
    expect(out[0].evidence.sample).toHaveLength(GROUP_SAMPLE);
    expect(out[0].evidence.sample).toEqual(["https://a.test/p/1", "https://a.test/p/12", "https://a.test/p/2", "https://a.test/p/3", "https://a.test/p/5"]);
    expect(out[0].message).toContain("6 other page(s)");
  });

  it("groups a sitewide finding across templates, and says it is one fix", () => {
    const g = new TemplateGroups();
    const cta = (url: string): Finding => ({ ...f(url, "upload -> home", []), ruleId: "LNK-016", message: `"Upload" links to the homepage.`, evidence: { groupKey: "upload -> home", sitewide: true } });
    g.add([cta("https://a.test/")], "tpl-home");
    g.add([cta("https://a.test/p/1")], "tpl-product");
    g.add([cta("https://a.test/blog/")], null);
    const out = g.findings();
    expect(out).toHaveLength(1);
    expect(out[0].evidence.pages).toBe(3);
    expect(out[0].message).toContain("affects 3 pages, one template fix");
    // Without the flag, the same key stays one group per template.
    const h = new TemplateGroups();
    for (const [u, t] of [["https://a.test/", "tpl-home"], ["https://a.test/p/1", "tpl-product"]]) h.add([{ ...cta(u), evidence: { groupKey: "k" } }], t);
    expect(h.findings()).toHaveLength(2);
  });

  it("keeps different schema types and different templates apart", () => {
    const g = new TemplateGroups();
    g.add([f("https://a.test/a", "Article", ["image"]), f("https://a.test/a", "Product", ["review"])], "tpl-1");
    g.add([f("https://a.test/b", "Article", ["image"])], "tpl-2");
    expect(
      g
        .findings()
        .map((x) => `${x.evidence.groupKey}@${x.url}`)
        .sort(),
    ).toEqual(["Article@https://a.test/a", "Article@https://a.test/b", "Product@https://a.test/a"]);
  });

  it("does not group pages without a template fingerprint, and passes inconclusive findings through", () => {
    const g = new TemplateGroups();
    g.add([f("https://a.test/a", "Article", ["image"])], null);
    g.add([f("https://a.test/b", "Article", ["image"])], null);
    const pass = g.add([f("https://a.test/c", "Article", [], "inconclusive")], "tpl");
    expect(pass).toHaveLength(1);
    expect(g.findings().map((x) => x.url).sort()).toEqual(["https://a.test/a", "https://a.test/b"]);
  });

  it("the result does not depend on the order pages arrive in", () => {
    const urls = Array.from({ length: 40 }, (_, i) => `https://a.test/p/${i}`);
    const run = (order: string[]) => {
      const g = new TemplateGroups();
      for (const u of order) g.add([f(u, "Product", ["review"])], "tpl");
      return g.findings();
    };
    expect(run([...urls].reverse())).toEqual(run(urls));
  });

  it("names the rules that report per template group", () => {
    expect(RULES.filter((r) => r.groupByTemplate).map((r) => r.id).sort()).toEqual(["CNT-021", "LNK-015", "LNK-016", "META-022", "META-023", "SD-004", "SD-011"]);
  });
});
