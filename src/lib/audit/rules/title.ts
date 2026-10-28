import { excerpt } from "../parse";
import type { CriterionEvaluator, RuleDef } from "../rule";

export const TITLE_RULE_ID = "title";

// Heuristic display-length thresholds. Search engines truncate by pixel width,
// not characters, so these are guidance — not hard limits.
export const TITLE_MIN_CHARS = 30;
export const TITLE_MAX_CHARS = 60;

export type TitleFacts = {
  /** Number of document <title> elements (SVG/MathML titles excluded). */
  titleCount: number;
  /** Whitespace-collapsed text of the first title, or null if none. */
  titleText: string | null;
  titleLength: number | null;
};

const num = (v: unknown) => (typeof v === "number" ? v : null);
const quoted = (text: unknown, len: unknown) =>
  typeof text === "string" ? `"${text}" (${len} chars)` : "no <title>";

export const titleEvaluators: Record<string, CriterionEvaluator> = {
  "title.present": (f) => ({
    passed: (num(f.titleCount) ?? 0) >= 1,
    actual: `${f.titleCount} <title> element(s)`,
  }),
  "title.exactly-one": (f) => ({
    passed: f.titleCount === 1,
    actual: `${f.titleCount} <title> element(s)`,
  }),
  "title.non-empty": (f) => ({
    passed: (num(f.titleLength) ?? 0) > 0,
    actual: quoted(f.titleText, f.titleLength),
  }),
  "title.max-length": (f, p) => {
    const len = num(f.titleLength);
    return { passed: len !== null && len > 0 && len <= Number(p.max), actual: quoted(f.titleText, len) };
  },
  "title.min-length": (f, p) => {
    const len = num(f.titleLength);
    return { passed: len !== null && len >= Number(p.min), actual: quoted(f.titleText, len) };
  },
};

const WHY_TITLE =
  "The title is the main label search engines and browsers show for the page. A missing or ambiguous title leaves search engines to generate one.";
const WHY_LENGTH =
  "Long titles are often truncated in search results, and very short ones tend to under-describe the page. This is a display heuristic, not a ranking rule.";

export const titleRule: RuleDef<TitleFacts> = {
  id: TITLE_RULE_ID,
  name: "Page title",
  category: "metadata",

  observe({ $ }) {
    // <title> inside inline SVG/MathML is element-level metadata, not the document title.
    const titles = $("title").filter((_, el) => $(el).parents("svg, math").length === 0);
    const text = titles.length ? titles.first().text().replace(/\s+/g, " ").trim() : null;
    return {
      facts: { titleCount: titles.length, titleText: text, titleLength: text === null ? null : text.length },
      snippets: titles.toArray().map((el) => excerpt($.html(el))),
    };
  },

  checks: [
    {
      code: "title/missing",
      severity: "high",
      kind: "defect",
      certainty: "verified",
      why: WHY_TITLE,
      detect: (f) => f.titleCount === 0,
      criteria: () => [
        { id: "title.present", description: "The page has a <title> element", params: {} },
        { id: "title.non-empty", description: "The first <title> contains text", params: {} },
      ],
      describe: () => ({
        title: "Missing <title> element",
        message: "The document has no <title> element.",
        observed: "0 <title> elements found",
        expected: "Exactly 1 non-empty <title> element in <head>",
        recommendations: [
          "Add a single, descriptive <title> inside <head> that summarises the page's primary topic.",
          "If titles are set by a CMS or SEO plugin, check that the template outputs it on this page type.",
        ],
      }),
    },
    {
      code: "title/multiple",
      severity: "medium",
      kind: "defect",
      certainty: "verified",
      why: WHY_TITLE,
      detect: (f) => f.titleCount > 1,
      criteria: () => [{ id: "title.exactly-one", description: "The page has exactly one <title> element", params: {} }],
      describe: (f) => ({
        title: "Multiple <title> elements",
        message: `The document contains ${f.titleCount} <title> elements. Browsers and crawlers use the first one; the rest are ignored or ambiguous.`,
        observed: `${f.titleCount} <title> elements found`,
        expected: "Exactly 1 <title> element",
        recommendations: [
          "Remove duplicate <title> elements so only one remains in <head>.",
          "Check layout templates, SEO plugins and client-side head managers for a second title.",
        ],
        diagnosis: "Often caused by a layout template and an SEO plugin (or head manager) both writing a title.",
      }),
    },
    {
      code: "title/empty",
      severity: "high",
      kind: "defect",
      certainty: "verified",
      why: WHY_TITLE,
      detect: (f) => f.titleCount >= 1 && f.titleLength === 0,
      criteria: () => [
        { id: "title.present", description: "The page has a <title> element", params: {} },
        { id: "title.non-empty", description: "The first <title> contains text", params: {} },
      ],
      describe: () => ({
        title: "Empty <title> element",
        message: "The <title> element is present but contains no text (or only whitespace).",
        observed: "Title text is empty",
        expected: "Non-empty, descriptive title text",
        recommendations: ["Write a unique, descriptive title for this page."],
      }),
    },
    {
      code: "title/too-long",
      severity: "low",
      kind: "warning",
      certainty: "heuristic",
      why: WHY_LENGTH,
      detect: (f) => (f.titleLength ?? 0) > TITLE_MAX_CHARS,
      criteria: () => [
        {
          id: "title.max-length",
          description: `The first <title> is 1–${TITLE_MAX_CHARS} characters (heuristic)`,
          params: { max: TITLE_MAX_CHARS },
        },
      ],
      describe: (f) => ({
        title: "Title may be truncated in search results",
        message: `The title is ${f.titleLength} characters. Titles longer than ~${TITLE_MAX_CHARS} characters are often truncated in search results (heuristic; the real limit is pixel-based).`,
        observed: quoted(f.titleText, f.titleLength),
        expected: `≤ ${TITLE_MAX_CHARS} characters (heuristic)`,
        recommendations: [
          "Shorten the title and move the most important words to the front.",
          "Drop repeated boilerplate such as long brand suffixes or shipping promos.",
        ],
      }),
    },
    {
      code: "title/too-short",
      severity: "low",
      kind: "warning",
      certainty: "heuristic",
      why: WHY_LENGTH,
      detect: (f) => (f.titleLength ?? 0) > 0 && (f.titleLength ?? 0) < TITLE_MIN_CHARS,
      criteria: () => [
        {
          id: "title.min-length",
          description: `The first <title> is at least ${TITLE_MIN_CHARS} characters (heuristic)`,
          params: { min: TITLE_MIN_CHARS },
        },
      ],
      describe: (f) => ({
        title: "Title may be too short",
        message: `The title is ${f.titleLength} characters. Titles under ~${TITLE_MIN_CHARS} characters often under-describe the page (heuristic).`,
        observed: quoted(f.titleText, f.titleLength),
        expected: `≥ ${TITLE_MIN_CHARS} characters (heuristic)`,
        recommendations: [
          "Expand the title to describe the page's topic more specifically, e.g. add the product, service or location.",
        ],
      }),
    },
  ],
};
