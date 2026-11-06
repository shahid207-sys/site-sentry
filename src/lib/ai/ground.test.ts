import { describe, expect, it } from "vitest";
import { groundAnalysis, MAX_QUOTE_WORDS, uncitedItems } from "./ground";
import { AiOutputSchema, type AiOutput } from "./schema";

const URL_A = "https://a.test/%D8%B7%D8%A8%D8%A7%D8%B9%D8%A9/";
const ctx = {
  findingIds: new Set(["META-004"]),
  pageText: new Map([
    [URL_A, "Same-day printing — in Dubai. Call us for a quote today."],
    ["https://a.test/", "Welcome to Acme Print"],
  ]),
};
const finding = { findingId: "META-004", url: null, quote: null };
const quote = (q: string, url = URL_A) => ({ findingId: null, url, quote: q });
const point = (text: string, ...citations: AiOutput["actionPlan"]["thisWeek"][number]["citations"]) => ({ text, citations });
const output = (over: Partial<AiOutput> = {}): AiOutput => ({
  executiveSummary: { strengths: [], weaknesses: [] },
  qualityIssues: [],
  rewrites: [],
  strategy: [],
  actionPlan: { thisWeek: [], thisQuarter: [] },
  ...over,
});
const week = (...items: AiOutput["actionPlan"]["thisWeek"]) => groundAnalysis(output({ actionPlan: { thisWeek: items, thisQuarter: [] } }), ctx);

describe("groundAnalysis", () => {
  it("keeps an item citing a finding of this crawl, and drops an unknown finding ID", () => {
    const { analysis, dropped } = week(point("Fix the titles.", finding), point("Fix the widgets.", { findingId: "META-999", url: null, quote: null }));
    expect(analysis.actionPlan.thisWeek.map((x) => x.text)).toEqual(["Fix the titles."]);
    expect(dropped).toMatchObject({ items: 1, citations: 1 });
  });

  it("keeps a quote found in that URL's stored text, ignoring case, spacing, typographic dashes and URL encoding", () => {
    const decoded = "https://a.test/طباعة";
    const { analysis, dropped } = week(point("Good.", quote("same-day  printing - IN Dubai", decoded)));
    expect(analysis.actionPlan.thisWeek).toHaveLength(1);
    expect(dropped.items).toBe(0);
  });

  it("drops a quote that is not in the stored text, or that is on another page", () => {
    const { analysis, dropped } = week(point("Invented.", quote("the best printer in the Gulf")), point("Wrong page.", quote("Welcome to Acme Print")));
    expect(analysis.actionPlan.thisWeek).toHaveLength(0);
    expect(dropped).toMatchObject({ items: 2, citations: 2 });
  });

  it("drops a URL without a quote, and a quote longer than the limit", () => {
    const long = Array.from({ length: MAX_QUOTE_WORDS + 1 }, () => "print").join(" ");
    const big = { ...ctx, pageText: new Map([[URL_A, long]]) };
    const r = groundAnalysis(output({ actionPlan: { thisWeek: [point("No quote.", { findingId: null, url: URL_A, quote: null }), point("Too long.", quote(long))], thisQuarter: [] } }), big);
    expect(r.analysis.actionPlan.thisWeek).toHaveLength(0);
    expect(r.dropped.citations).toBe(2);
  });

  it("keeps the valid citation of an item that also has an invalid one", () => {
    const { analysis, dropped } = week(point("Mixed.", finding, quote("not on the page at all")));
    expect(analysis.actionPlan.thisWeek[0].citations).toEqual([finding]);
    expect(dropped).toMatchObject({ items: 0, citations: 1 });
  });

  it.each(["This will improve your rankings.", "Expect more organic traffic.", "Google may apply a penalty."])("drops a banned claim however well cited: %s", (text) => {
    const { analysis, dropped } = week(point(text, finding));
    expect(analysis.actionPlan.thisWeek).toHaveLength(0);
    expect(dropped.bannedClaims).toBe(1);
  });

  it("drops an item whose own text quotes words the site does not contain", () => {
    const { analysis, dropped } = week(point('The page says "cheapest printing in town" twice.', finding), point('The page says "call us for a quote".', finding));
    expect(analysis.actionPlan.thisWeek.map((x) => x.text)).toEqual(['The page says "call us for a quote".']);
    expect(dropped.unsupportedQuotes).toBe(1);
  });

  it("computes character counts itself, and does not treat rewrite copy as a claim", () => {
    const r = groundAnalysis(output({ rewrites: [{ url: URL_A, title: "Traffic signs | Acme", description: "طباعة", h1: "Signs", citations: [finding] }] }), ctx);
    expect(r.analysis.rewrites[0]).toMatchObject({ titleChars: 20, descriptionChars: 5 });
  });

  it("leaves no uncited item in any section", () => {
    const bad = point("No citation.");
    const r = groundAnalysis(
      {
        executiveSummary: { strengths: [bad], weaknesses: [bad] },
        qualityIssues: [{ kind: "tone", url: URL_A, issue: "x", fix: "y", citations: [] }],
        rewrites: [{ url: URL_A, title: "t", description: "d", h1: "h", citations: [] }],
        strategy: [{ area: "architecture", text: "x", citations: [] }],
        actionPlan: { thisWeek: [bad], thisQuarter: [bad] },
      },
      ctx,
    );
    expect(uncitedItems(r.analysis)).toBe(0);
    expect(r.dropped.items).toBe(7);
  });
});

describe("AiOutputSchema", () => {
  it("rejects output of the wrong shape", () => {
    expect(AiOutputSchema.safeParse({ executiveSummary: "good" }).success).toBe(false);
    expect(AiOutputSchema.safeParse(output()).success).toBe(true);
  });
});

describe("groundAnalysis rewrite language", () => {
  const AR = "https://a.test/ar/";
  const langCtx = { ...ctx, pageLanguage: new Map<string, string | null>([[AR, "ar"], ["https://a.test/", "en"]]) };
  const rewrite = (url: string, title: string, description: string, h1: string) => ({ url, title, description, h1, citations: [finding] });

  it("drops a rewrite that is not in its page's detected language, and keeps one that is", () => {
    const { analysis, dropped } = groundAnalysis(
      output({
        rewrites: [
          rewrite(AR, "3D Printing in Sharjah | Acme", "Custom 3D printed models for your projects.", "3D Printing in Sharjah"),
          rewrite(AR, "طباعة ثلاثية الأبعاد في الشارقة | Acme", "نماذج مطبوعة حسب الطلب لمشاريعك.", "طباعة ثلاثية الأبعاد"),
          rewrite("https://a.test/", "Acme Print | Same-day printing", "Same-day printing for your business, with a quote today.", "Same-day printing"),
        ],
      }),
      langCtx,
    );
    expect(analysis.rewrites.map((r) => r.title)).toEqual(["طباعة ثلاثية الأبعاد في الشارقة | Acme", "Acme Print | Same-day printing"]);
    expect(dropped).toMatchObject({ items: 1, wrongLanguage: 1 });
  });

  it("keeps a rewrite for a page whose language is unknown", () => {
    const { analysis, dropped } = groundAnalysis(output({ rewrites: [rewrite("https://a.test/other", "Acme | Print", "Print with us.", "Print")] }), langCtx);
    expect(analysis.rewrites).toHaveLength(1);
    expect(dropped.wrongLanguage).toBe(0);
  });
});
