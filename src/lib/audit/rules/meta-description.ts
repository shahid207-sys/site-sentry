import { excerpt } from "../parse";
import type { CriterionEvaluator, RuleDef } from "../rule";
import { num } from "../rule";

// Heuristic display thresholds. Snippets are truncated by pixel width and are often rewritten anyway.
export const DESCRIPTION_MIN_CHARS = 70;
export const DESCRIPTION_MAX_CHARS = 160;

export type DescriptionFacts = {
  descriptionCount: number;
  descriptionText: string | null;
  descriptionLength: number | null;
};

const quoted = (f: { descriptionText?: unknown; descriptionLength?: unknown }) =>
  typeof f.descriptionText === "string" ? `"${f.descriptionText}" (${f.descriptionLength} chars)` : "no meta description";

export const descriptionEvaluators: Record<string, CriterionEvaluator> = {
  "description.present": (f) => ({ passed: (num(f.descriptionCount) ?? 0) >= 1, actual: `${f.descriptionCount} meta description(s)` }),
  "description.non-empty": (f) => ({ passed: (num(f.descriptionLength) ?? 0) > 0, actual: quoted(f) }),
  "description.exactly-one": (f) => ({ passed: f.descriptionCount === 1, actual: `${f.descriptionCount} meta description(s)` }),
  "description.max-length": (f, p) => {
    const len = num(f.descriptionLength);
    return { passed: len !== null && len > 0 && len <= Number(p.max), actual: quoted(f) };
  },
  "description.min-length": (f, p) => {
    const len = num(f.descriptionLength);
    return { passed: len !== null && len >= Number(p.min), actual: quoted(f) };
  },
};

const WHY = "Search engines often use the meta description as the result snippet. Without one, they pick text from the page, which may not describe it well.";
const WHY_LEN = "Long descriptions are truncated in results and very short ones say little. This is a display heuristic; search engines frequently rewrite snippets.";

export const metaDescriptionRule: RuleDef<DescriptionFacts> = {
  id: "meta-description",
  name: "Meta description",
  category: "metadata",

  observe({ $ }) {
    const metas = $("meta").filter((_, el) => ($(el).attr("name") ?? "").toLowerCase() === "description");
    const text = metas.length ? (metas.first().attr("content") ?? "").replace(/\s+/g, " ").trim() : null;
    return {
      facts: { descriptionCount: metas.length, descriptionText: text, descriptionLength: text === null ? null : text.length },
      snippets: metas.toArray().map((el) => excerpt($.html(el))),
    };
  },

  checks: [
    {
      code: "meta-description/missing",
      severity: "medium",
      kind: "warning",
      certainty: "verified",
      why: WHY,
      detect: (f) => f.descriptionCount === 0,
      criteria: () => [
        { id: "description.present", description: "The page has a meta description", params: {} },
        { id: "description.non-empty", description: "The meta description has text", params: {} },
      ],
      describe: () => ({
        title: "Missing meta description",
        message: "The page has no <meta name=\"description\">.",
        observed: "No meta description",
        expected: "One descriptive meta description",
        recommendations: ["Write a unique meta description summarising the page for searchers.", "Check that the CMS template outputs the description field for this page type."],
      }),
    },
    {
      code: "meta-description/empty",
      severity: "medium",
      kind: "warning",
      certainty: "verified",
      why: WHY,
      detect: (f) => f.descriptionCount >= 1 && f.descriptionLength === 0,
      criteria: () => [{ id: "description.non-empty", description: "The meta description has text", params: {} }],
      describe: () => ({
        title: "Empty meta description",
        message: "The meta description tag exists but its content is empty.",
        observed: 'content=""',
        expected: "A non-empty description",
        recommendations: ["Fill in the description, or remove the empty tag so the template default can apply."],
      }),
    },
    {
      code: "meta-description/multiple",
      severity: "low",
      kind: "warning",
      certainty: "verified",
      why: WHY,
      detect: (f) => f.descriptionCount > 1,
      criteria: () => [{ id: "description.exactly-one", description: "The page has exactly one meta description", params: {} }],
      describe: (f) => ({
        title: "Multiple meta descriptions",
        message: `The page has ${f.descriptionCount} meta description tags; which one is used is not defined.`,
        observed: `${f.descriptionCount} meta descriptions`,
        expected: "Exactly one",
        recommendations: ["Remove the duplicate tag (often added by both a theme and an SEO plugin)."],
      }),
    },
    {
      code: "meta-description/too-long",
      severity: "low",
      kind: "opportunity",
      certainty: "heuristic",
      why: WHY_LEN,
      detect: (f) => (f.descriptionLength ?? 0) > DESCRIPTION_MAX_CHARS,
      criteria: () => [
        { id: "description.max-length", description: `The meta description is 1–${DESCRIPTION_MAX_CHARS} characters (heuristic)`, params: { max: DESCRIPTION_MAX_CHARS } },
      ],
      describe: (f) => ({
        title: "Meta description may be truncated",
        message: `The description is ${f.descriptionLength} characters; around ${DESCRIPTION_MAX_CHARS}+ is commonly truncated (heuristic).`,
        observed: quoted(f),
        expected: `≤ ${DESCRIPTION_MAX_CHARS} characters (heuristic)`,
        recommendations: ["Put the key message in the first ~150 characters."],
      }),
    },
    {
      code: "meta-description/too-short",
      severity: "low",
      kind: "opportunity",
      certainty: "heuristic",
      why: WHY_LEN,
      detect: (f) => (f.descriptionLength ?? 0) > 0 && (f.descriptionLength ?? 0) < DESCRIPTION_MIN_CHARS,
      criteria: () => [
        { id: "description.min-length", description: `The meta description is at least ${DESCRIPTION_MIN_CHARS} characters (heuristic)`, params: { min: DESCRIPTION_MIN_CHARS } },
      ],
      describe: (f) => ({
        title: "Meta description may be too short",
        message: `The description is ${f.descriptionLength} characters (heuristic minimum ${DESCRIPTION_MIN_CHARS}).`,
        observed: quoted(f),
        expected: `≥ ${DESCRIPTION_MIN_CHARS} characters (heuristic)`,
        recommendations: ["Describe what the visitor will find on the page and why it is relevant."],
      }),
    },
  ],
};
