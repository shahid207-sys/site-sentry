import { excerpt, type Doc } from "../parse";
import type { Finding, RuleResult } from "../types";

export const TITLE_RULE_ID = "title";

// Heuristic display-length thresholds. Search engines truncate by pixel width,
// not characters, so these are guidance — not hard limits.
export const TITLE_MIN_CHARS = 30;
export const TITLE_MAX_CHARS = 60;

/** Collapse whitespace the way browsers do when rendering a document title. */
function normaliseTitle(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function checkTitle($: Doc): RuleResult {
  // <title> inside inline SVG/MathML is element-level metadata, not the document title.
  const titles = $("title").filter((_, el) => $(el).parents("svg, math").length === 0);
  const snippets = titles.toArray().map((el) => excerpt($.html(el)));
  const findings: Finding[] = [];

  if (titles.length === 0) {
    findings.push({
      ruleId: "title/missing",
      severity: "high",
      title: "Missing <title> element",
      message: "The document has no <title> element.",
      evidence: {
        observed: "0 <title> elements found",
        expected: "Exactly 1 <title> element in <head>",
        snippets: [],
      },
      recommendation:
        "Add a single, descriptive <title> inside <head> that summarises the page's primary topic.",
    });
    return { ruleId: TITLE_RULE_ID, name: "Page title", passed: false, findings };
  }

  if (titles.length > 1) {
    findings.push({
      ruleId: "title/multiple",
      severity: "medium",
      title: "Multiple <title> elements",
      message: `The document contains ${titles.length} <title> elements. Browsers and crawlers use the first one; the rest are ignored or ambiguous.`,
      evidence: {
        observed: `${titles.length} <title> elements found`,
        expected: "Exactly 1 <title> element",
        snippets,
      },
      recommendation:
        "Remove duplicate <title> elements so only one remains in <head>. Check templates, plugins and injected scripts for extra tags.",
    });
  }

  // Length/emptiness checks apply to the title browsers actually use: the first one.
  const text = normaliseTitle(titles.first().text());
  const firstSnippet = snippets[0] ? [snippets[0]] : [];

  if (text.length === 0) {
    findings.push({
      ruleId: "title/empty",
      severity: "high",
      title: "Empty <title> element",
      message: "The <title> element is present but contains no text (or only whitespace).",
      evidence: {
        observed: "Title text is empty",
        expected: "Non-empty, descriptive title text",
        snippets: firstSnippet,
      },
      recommendation: "Write a unique, descriptive title for this page.",
    });
  } else if (text.length > TITLE_MAX_CHARS) {
    findings.push({
      ruleId: "title/too-long",
      severity: "low",
      title: "Title may be truncated in search results",
      message: `The title is ${text.length} characters. Titles longer than ~${TITLE_MAX_CHARS} characters are often truncated in search results (heuristic; actual limit is pixel-based).`,
      evidence: {
        observed: `"${text}" (${text.length} chars)`,
        expected: `≤ ${TITLE_MAX_CHARS} characters (heuristic)`,
        snippets: firstSnippet,
      },
      recommendation:
        "Shorten the title and move the most important words to the front.",
    });
  } else if (text.length < TITLE_MIN_CHARS) {
    findings.push({
      ruleId: "title/too-short",
      severity: "low",
      title: "Title may be too short",
      message: `The title is ${text.length} characters. Titles under ~${TITLE_MIN_CHARS} characters often under-describe the page (heuristic).`,
      evidence: {
        observed: `"${text}" (${text.length} chars)`,
        expected: `≥ ${TITLE_MIN_CHARS} characters (heuristic)`,
        snippets: firstSnippet,
      },
      recommendation:
        "Expand the title to describe the page's topic more specifically, e.g. add the product, service or location.",
    });
  }

  return { ruleId: TITLE_RULE_ID, name: "Page title", passed: findings.length === 0, findings };
}
