import { excerpt } from "../parse";
import type { CriterionEvaluator, RuleDef } from "../rule";
import { num } from "../rule";

export type HeadingFacts = {
  h1Count: number;
  h1Text: string | null;
  /** Number of places where the outline jumps more than one level down, e.g. h2 → h4. */
  skippedLevels: number;
  /** First skipped jump, e.g. "h2 → h4", or null. */
  firstSkip: string | null;
  headingCount: number;
};

export const headingEvaluators: Record<string, CriterionEvaluator> = {
  "headings.h1-present": (f) => ({ passed: (num(f.h1Count) ?? 0) >= 1, actual: `${f.h1Count} <h1> element(s)` }),
  "headings.h1-non-empty": (f) => ({
    passed: typeof f.h1Text === "string" && f.h1Text.length > 0,
    actual: typeof f.h1Text === "string" ? `"${f.h1Text}"` : "no <h1>",
  }),
  "headings.h1-max": (f, p) => ({ passed: (num(f.h1Count) ?? 99) <= Number(p.max), actual: `${f.h1Count} <h1> element(s)` }),
  "headings.no-skips": (f) => ({ passed: f.skippedLevels === 0, actual: f.firstSkip ? `${f.skippedLevels} skip(s), first ${f.firstSkip}` : "no skipped levels" }),
};

export const headingsRule: RuleDef<HeadingFacts> = {
  id: "headings",
  name: "Headings",
  category: "metadata",

  observe({ $ }) {
    const headings = $("h1, h2, h3, h4, h5, h6").toArray();
    const h1s = headings.filter((el) => (el as { tagName: string }).tagName.toLowerCase() === "h1");
    let skipped = 0;
    let firstSkip: string | null = null;
    let prev = 0;
    for (const el of headings) {
      const level = Number((el as { tagName: string }).tagName.slice(1));
      if (prev && level > prev + 1) {
        skipped++;
        firstSkip ??= `h${prev} → h${level}`;
      }
      prev = level;
    }
    const h1Text = h1s.length ? $(h1s[0]).text().replace(/\s+/g, " ").trim() : null;
    return {
      facts: { h1Count: h1s.length, h1Text, skippedLevels: skipped, firstSkip, headingCount: headings.length },
      snippets: headings.slice(0, 12).map((el) => {
        const tag = (el as { tagName: string }).tagName.toLowerCase();
        return `${"  ".repeat(Number(tag[1]) - 1)}<${tag}>${excerpt($(el).text(), 90)}</${tag}>`;
      }),
    };
  },

  checks: [
    {
      code: "headings/missing-h1",
      severity: "medium",
      kind: "warning",
      certainty: "verified",
      why: "The main heading tells visitors and search engines what the page is about. Pages without one are harder to scan.",
      detect: (f) => f.h1Count === 0,
      criteria: () => [
        { id: "headings.h1-present", description: "The page has an <h1>", params: {} },
        { id: "headings.h1-non-empty", description: "The first <h1> has text", params: {} },
      ],
      describe: () => ({
        title: "No <h1> heading",
        message: "The page has no <h1> element.",
        observed: "0 <h1> elements",
        expected: "One <h1> describing the page's main topic",
        recommendations: ["Add a single visible <h1> that states the page's main topic.", "If the design uses a styled <div> as the heading, change it to an <h1>."],
      }),
    },
    {
      code: "headings/empty-h1",
      severity: "medium",
      kind: "warning",
      certainty: "verified",
      why: "An empty <h1> provides no topic signal and is confusing for screen-reader users.",
      detect: (f) => f.h1Count >= 1 && f.h1Text === "",
      criteria: () => [{ id: "headings.h1-non-empty", description: "The first <h1> has text", params: {} }],
      describe: () => ({
        title: "Empty <h1> heading",
        message: "The first <h1> contains no text (it may contain only an image or whitespace).",
        observed: "<h1> with no text",
        expected: "Descriptive heading text",
        recommendations: ["Add text to the <h1>; if it wraps a logo image, give the main heading its own <h1> instead."],
      }),
    },
    {
      code: "headings/multiple-h1",
      severity: "low",
      kind: "observation",
      certainty: "needs_review",
      why: "Multiple <h1>s are valid HTML. This is a house-style convention check that some teams prefer; switch it off in Settings if it does not apply.",
      enabled: (c) => c.multipleH1 === "warn",
      detect: (f) => f.h1Count > 1,
      criteria: () => [{ id: "headings.h1-max", description: "The page has at most one <h1> (convention)", params: { max: 1 } }],
      describe: (f) => ({
        title: "More than one <h1>",
        message: `The page has ${f.h1Count} <h1> elements.`,
        observed: `${f.h1Count} <h1> elements; first: "${f.h1Text ?? ""}"`,
        expected: "One <h1> (house convention)",
        recommendations: ["Keep one <h1> for the main topic and demote the others to <h2>, if your convention requires it."],
      }),
    },
    {
      code: "headings/skipped-level",
      severity: "low",
      kind: "observation",
      certainty: "needs_review",
      why: "Skipped heading levels make the outline harder to follow for assistive technology. It rarely matters for search on its own.",
      detect: (f) => f.skippedLevels > 0,
      criteria: () => [{ id: "headings.no-skips", description: "Heading levels never skip (e.g. h2 → h4)", params: {} }],
      describe: (f) => ({
        title: "Heading levels are skipped",
        message: `The heading outline jumps levels ${f.skippedLevels} time(s), first at ${f.firstSkip}.`,
        observed: `${f.skippedLevels} skip(s); first ${f.firstSkip}`,
        expected: "Each heading is at most one level deeper than the previous one",
        recommendations: ["Use heading levels for structure, and CSS for size."],
      }),
    },
  ],
};
