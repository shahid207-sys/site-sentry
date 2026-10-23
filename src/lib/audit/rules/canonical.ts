import { excerpt } from "../parse";
import type { CriterionEvaluator, RuleDef } from "../rule";
import type { AcceptanceCriterion } from "../types";

export type CanonicalFacts = {
  /** Number of <link rel="canonical"> elements in the document. */
  canonicalCount: number;
  /** href of the first canonical as written in the HTML. */
  canonicalHref: string | null;
  /** First canonical resolved against the page URL, or null if absent/unparseable. */
  canonicalResolved: string | null;
};

/** Normalise for comparison: absolute, no fragment. Returns null for unparseable input. */
export function normaliseUrl(href: string, base?: string): string | null {
  try {
    const u = new URL(href, base);
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

export const canonicalEvaluators: Record<string, CriterionEvaluator> = {
  "canonical.single": (f) => ({
    passed: f.canonicalCount === 1,
    actual: `${f.canonicalCount} canonical link(s)`,
  }),
  "canonical.equals": (f, p) => ({
    passed: f.canonicalCount === 1 && f.canonicalResolved !== null && f.canonicalResolved === normaliseUrl(String(p.expected)),
    actual: f.canonicalResolved ? String(f.canonicalResolved) : "no canonical",
  }),
};

export const canonicalRule: RuleDef<CanonicalFacts> = {
  id: "canonical",
  name: "Canonical URL",
  needs: ["canonicalUrl"],

  observe({ $, pageUrl }) {
    const links = $("link").filter((_, el) =>
      ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"),
    );
    const href = links.first().attr("href")?.trim() ?? null;
    return {
      facts: {
        canonicalCount: links.length,
        canonicalHref: href,
        canonicalResolved: href ? normaliseUrl(href, pageUrl) : null,
      },
      snippets: links.toArray().map((el) => excerpt($.html(el))),
    };
  },

  checks: [
    {
      code: "canonical/expected-url",
      severity: "high",
      detect: (f, exp) =>
        f.canonicalCount !== 1 || f.canonicalResolved !== normaliseUrl(exp.canonicalUrl ?? ""),
      criteria: (exp): AcceptanceCriterion[] => [
        { id: "canonical.single", description: "The page has exactly one rel=canonical link", params: {} },
        {
          id: "canonical.equals",
          description: `The canonical points to ${normaliseUrl(exp.canonicalUrl ?? "") ?? exp.canonicalUrl}`,
          params: { expected: normaliseUrl(exp.canonicalUrl ?? "") ?? String(exp.canonicalUrl) },
        },
      ],
      describe: (f, exp) => {
        const expected = normaliseUrl(exp.canonicalUrl ?? "") ?? String(exp.canonicalUrl);
        const observed =
          f.canonicalCount === 0
            ? "No rel=canonical link"
            : f.canonicalCount > 1
              ? `${f.canonicalCount} rel=canonical links; first is ${f.canonicalResolved ?? f.canonicalHref}`
              : `Canonical is ${f.canonicalResolved ?? f.canonicalHref}`;
        return {
          title:
            f.canonicalCount === 0
              ? "Canonical link missing"
              : f.canonicalCount > 1
                ? "Multiple canonical links"
                : "Canonical points to the wrong URL",
          message: `The configured canonical for this page is ${expected}, but the page does not declare exactly that.`,
          observed,
          expected: `Exactly one <link rel="canonical" href="${expected}">`,
          recommendations: [
            `Output a single <link rel="canonical" href="${expected}"> in <head>.`,
            "Remove extra canonical tags added by plugins or duplicated layouts.",
          ],
        };
      },
    },
  ],
};
