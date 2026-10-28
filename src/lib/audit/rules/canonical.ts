import { excerpt } from "../parse";
import type { CriterionEvaluator, RuleDef } from "../rule";
import type { AcceptanceCriterion, PageExpectations } from "../types";

export type CanonicalFacts = {
  /** Number of <link rel="canonical"> elements in the document. */
  canonicalCount: number;
  /** href of the first canonical as written in the HTML. */
  canonicalHref: string | null;
  /** First canonical resolved against the page URL, or null if absent/unparseable. */
  canonicalResolved: string | null;
  /** The first canonical resolves to the page's own URL. */
  canonicalSelf: boolean;
  /** Canonical declared in a `Link: <…>; rel="canonical"` response header, resolved. */
  canonicalHeader: string | null;
};

/** Normalise for comparison: absolute, no fragment. Returns null for unparseable input. */
export function normaliseUrl(href: string, base?: string): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

const expectedOf = (exp: PageExpectations) => normaliseUrl(exp.canonicalUrl ?? "") ?? String(exp.canonicalUrl);

function headerCanonical(link: string | undefined, base: string): string | null {
  if (!link) return null;
  for (const part of link.split(/,(?=\s*<)/)) {
    const m = part.match(/<([^>]*)>\s*;(.*)$/);
    if (m && /rel\s*=\s*"?([^";]*\s)?canonical(\s[^";]*)?"?/i.test(m[2])) return normaliseUrl(m[1].trim(), base);
  }
  return null;
}

export const canonicalEvaluators: Record<string, CriterionEvaluator> = {
  "canonical.single": (f) => ({
    passed: f.canonicalCount === 1,
    actual: `${f.canonicalCount} canonical link(s)`,
  }),
  "canonical.at-most-one": (f) => ({
    passed: typeof f.canonicalCount === "number" && f.canonicalCount <= 1,
    actual: `${f.canonicalCount} canonical link(s)`,
  }),
  "canonical.valid-href": (f) => ({
    passed: f.canonicalCount === 0 || f.canonicalResolved !== null,
    actual: f.canonicalCount === 0 ? "no canonical" : f.canonicalResolved ? String(f.canonicalResolved) : `unparseable href "${f.canonicalHref ?? ""}"`,
  }),
  "canonical.equals": (f, p) => ({
    passed: f.canonicalCount === 1 && f.canonicalResolved !== null && f.canonicalResolved === normaliseUrl(String(p.expected)),
    actual: f.canonicalResolved ? String(f.canonicalResolved) : "no canonical",
  }),
  "canonical.self-or-absent": (f) => ({
    passed: f.canonicalCount === 0 || f.canonicalSelf === true,
    actual: f.canonicalResolved ? `canonical → ${f.canonicalResolved}` : "no canonical",
  }),
};

const WHY_CANONICAL =
  "rel=canonical tells search engines which URL should represent this content. Conflicting or wrong canonicals can lead them to index a different URL than intended.";

export const canonicalRule: RuleDef<CanonicalFacts> = {
  id: "canonical",
  name: "Canonical URL",
  category: "indexability",

  observe({ $, pageUrl, headers }) {
    const links = $("link").filter((_, el) =>
      ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"),
    );
    const href = links.first().attr("href")?.trim() ?? null;
    const resolved = href ? normaliseUrl(href, pageUrl) : null;
    const snippets = links.toArray().map((el) => excerpt($.html(el)));
    const header = headerCanonical(headers["link"], pageUrl);
    if (header) snippets.push(`Link: <${header}>; rel="canonical"`);
    return {
      facts: {
        canonicalCount: links.length,
        canonicalHref: href,
        canonicalResolved: resolved,
        canonicalSelf: resolved !== null && resolved === normaliseUrl(pageUrl),
        canonicalHeader: header,
      },
      snippets,
    };
  },

  checks: [
    {
      code: "canonical/multiple",
      severity: "medium",
      kind: "defect",
      certainty: "verified",
      why: WHY_CANONICAL,
      detect: (f) => f.canonicalCount > 1,
      criteria: () => [{ id: "canonical.at-most-one", description: "The page has at most one rel=canonical link", params: {} }],
      describe: (f) => ({
        title: "Multiple canonical links",
        message: `The page declares ${f.canonicalCount} rel=canonical links. Search engines may ignore all of them when they conflict.`,
        observed: `${f.canonicalCount} rel=canonical links; first is ${f.canonicalResolved ?? f.canonicalHref}`,
        expected: "At most one rel=canonical link",
        recommendations: ["Keep a single canonical link in <head> and remove the others."],
        diagnosis: "Commonly caused by a theme and an SEO plugin both emitting a canonical tag.",
      }),
    },
    {
      code: "canonical/invalid",
      severity: "medium",
      kind: "defect",
      certainty: "verified",
      why: WHY_CANONICAL,
      detect: (f) => f.canonicalCount >= 1 && f.canonicalResolved === null,
      criteria: () => [{ id: "canonical.valid-href", description: "The canonical href is a valid http(s) URL", params: {} }],
      describe: (f) => ({
        title: "Canonical link has an invalid URL",
        message: "The canonical link's href is empty or cannot be resolved to an http(s) URL.",
        observed: `href="${f.canonicalHref ?? ""}"`,
        expected: "An absolute (or resolvable relative) http(s) URL",
        recommendations: ["Set the canonical href to the page's preferred absolute URL."],
      }),
    },
    {
      code: "canonical/expected-url",
      severity: "high",
      kind: "defect",
      certainty: "verified",
      why: WHY_CANONICAL,
      needs: ["canonicalUrl"],
      expectationKey: (exp) => `canonical=${expectedOf(exp)}`,
      // More than one canonical is reported by canonical/multiple; this check judges the declared target.
      detect: (f, exp) => f.canonicalCount === 0 || (f.canonicalCount === 1 && f.canonicalResolved !== normaliseUrl(exp.canonicalUrl ?? "")),
      criteria: (exp): AcceptanceCriterion[] => [
        { id: "canonical.single", description: "The page has exactly one rel=canonical link", params: {} },
        { id: "canonical.equals", description: `The canonical points to ${expectedOf(exp)}`, params: { expected: expectedOf(exp) } },
      ],
      describe: (f, exp) => {
        const expected = expectedOf(exp);
        return {
          title: f.canonicalCount === 0 ? "Canonical link missing" : "Canonical points to the wrong URL",
          message: `The configured canonical for this page is ${expected}, but the page does not declare exactly that.`,
          observed: f.canonicalCount === 0 ? "No rel=canonical link" : `Canonical is ${f.canonicalResolved ?? f.canonicalHref}`,
          expected: `Exactly one <link rel="canonical" href="${expected}">`,
          recommendations: [
            `Output a single <link rel="canonical" href="${expected}"> in <head>.`,
            "Check whether tracking parameters or a staging hostname are leaking into the canonical template.",
          ],
        };
      },
    },
    {
      code: "canonical/indexable-points-elsewhere",
      severity: "high",
      kind: "defect",
      certainty: "verified",
      why: "A page meant to be indexed that canonicalises to another URL asks search engines to index that other URL instead.",
      needs: ["indexability"],
      expectationKey: () => "indexability=index",
      detect: (f, exp) => exp.indexability === "index" && !exp.canonicalUrl && f.canonicalCount === 1 && f.canonicalResolved !== null && !f.canonicalSelf,
      criteria: () => [
        { id: "canonical.self-or-absent", description: "The canonical is self-referencing (or absent)", params: {} },
      ],
      describe: (f) => ({
        title: "Indexable page canonicalises to another URL",
        message: "This page is configured to be indexed, but its canonical points to a different URL.",
        observed: `Canonical → ${f.canonicalResolved}`,
        expected: "A self-referencing canonical, or configure the intended canonical URL for this page",
        recommendations: [
          "If this page should rank on its own, make the canonical self-referencing.",
          "If the other URL is the preferred version, set it as this page's expected canonical (and reconsider whether the page should be marked indexable).",
        ],
      }),
    },
    {
      code: "canonical/cross-url",
      severity: "low",
      kind: "observation",
      certainty: "needs_review",
      why: "A cross-URL canonical is often intentional (variants, parameters, syndicated copies). It only needs action if this page should be indexed on its own.",
      detect: (f, exp) => !exp.canonicalUrl && exp.indexability !== "index" && f.canonicalCount === 1 && f.canonicalResolved !== null && !f.canonicalSelf,
      criteria: () => [
        { id: "canonical.self-or-absent", description: "The canonical is self-referencing (or absent)", params: {} },
      ],
      describe: (f) => ({
        title: "Canonical points to a different URL",
        message: "The page's canonical names another URL. Confirm this is intended.",
        observed: `Canonical → ${f.canonicalResolved}`,
        expected: "Intended behaviour confirmed by configuring this page's expected canonical or indexability",
        recommendations: [
          "If intended, record the expected canonical for this URL in Sites → URLs so future audits judge against it.",
          "If not intended, make the canonical self-referencing.",
        ],
      }),
    },
  ],
};
