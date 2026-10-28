import { excerpt } from "../parse";
import type { CriterionEvaluator, RuleDef } from "../rule";
import { num } from "../rule";

export type InternationalFacts = {
  htmlLang: string | null;
  htmlLangValid: boolean;
  hreflangCount: number;
  hreflangInvalidCount: number;
  hreflangInvalidValues: string | null;
  hreflangRelativeCount: number;
};

// BCP 47 subset accepted by hreflang: language, optional script, optional region; or x-default.
const LANG_RE = /^[a-z]{2,3}(-[a-z]{4})?(-([a-z]{2}|\d{3}))?$/i;
export const isValidHreflang = (v: string) => v.toLowerCase() === "x-default" || LANG_RE.test(v);

export const internationalEvaluators: Record<string, CriterionEvaluator> = {
  "lang.present": (f) => ({ passed: f.htmlLangValid === true, actual: f.htmlLang ? `lang="${f.htmlLang}"` : "no lang attribute" }),
  "hreflang.valid-codes": (f) => ({
    passed: num(f.hreflangInvalidCount) === 0,
    actual: f.hreflangInvalidValues ? `invalid: ${f.hreflangInvalidValues}` : `${f.hreflangCount} valid hreflang link(s)`,
  }),
  "hreflang.absolute": (f) => ({ passed: num(f.hreflangRelativeCount) === 0, actual: `${f.hreflangRelativeCount} relative hreflang href(s)` }),
};

export const internationalRule: RuleDef<InternationalFacts> = {
  id: "international",
  name: "Language & hreflang",
  category: "international",

  observe({ $ }) {
    const lang = $("html").attr("lang")?.trim() ?? null;
    const alternates = $("link").filter(
      (_, el) => ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/).includes("alternate") && $(el).attr("hreflang") !== undefined,
    );
    const values = alternates.toArray().map((el) => ($(el).attr("hreflang") ?? "").trim());
    const invalid = [...new Set(values.filter((v) => !isValidHreflang(v)))];
    const relative = alternates.toArray().filter((el) => !/^https?:\/\//i.test(($(el).attr("href") ?? "").trim())).length;
    return {
      facts: {
        htmlLang: lang,
        htmlLangValid: lang !== null && isValidHreflang(lang) && lang.toLowerCase() !== "x-default",
        hreflangCount: alternates.length,
        hreflangInvalidCount: invalid.length,
        hreflangInvalidValues: invalid.length ? invalid.slice(0, 10).map((v) => `"${v}"`).join(", ") : null,
        hreflangRelativeCount: relative,
      },
      snippets: [
        lang !== null ? `<html lang="${lang}">` : "<html> (no lang attribute)",
        ...alternates.toArray().slice(0, 10).map((el) => excerpt($.html(el))),
      ],
    };
  },

  checks: [
    {
      code: "international/missing-lang",
      severity: "low",
      kind: "warning",
      certainty: "verified",
      why: "The lang attribute tells browsers and assistive technology which language the page is in. Search engines mostly detect language from content.",
      detect: (f) => !f.htmlLangValid,
      criteria: () => [{ id: "lang.present", description: "<html> has a valid lang attribute", params: {} }],
      describe: (f) => ({
        title: f.htmlLang ? "Invalid html lang value" : "Missing html lang attribute",
        message: f.htmlLang ? `lang="${f.htmlLang}" is not a valid language code.` : "The <html> element has no lang attribute.",
        observed: f.htmlLang ? `lang="${f.htmlLang}"` : "no lang attribute",
        expected: 'A language code such as lang="en" or lang="en-GB"',
        recommendations: ['Set lang on the <html> element in the base layout, e.g. <html lang="en">.'],
      }),
    },
    {
      code: "international/invalid-hreflang",
      severity: "medium",
      kind: "defect",
      certainty: "verified",
      why: "Invalid hreflang codes are ignored, so the alternate-language relationship they describe has no effect.",
      detect: (f) => f.hreflangInvalidCount > 0,
      criteria: () => [{ id: "hreflang.valid-codes", description: "Every hreflang value is a valid language(-region) code or x-default", params: {} }],
      describe: (f) => ({
        title: "Invalid hreflang values",
        message: `${f.hreflangInvalidCount} hreflang value(s) are not valid language codes.`,
        observed: f.hreflangInvalidValues ?? "",
        expected: 'ISO 639-1 language with optional ISO 3166-1 region, e.g. "en-GB" (not "en-UK"), or "x-default"',
        recommendations: ["Correct the codes, e.g. use en-GB rather than en-UK, and a language before any region."],
      }),
    },
    {
      code: "international/relative-hreflang",
      severity: "low",
      kind: "warning",
      certainty: "verified",
      why: "hreflang alternates are expected to use fully-qualified URLs.",
      detect: (f) => f.hreflangRelativeCount > 0,
      criteria: () => [{ id: "hreflang.absolute", description: "Every hreflang link uses an absolute URL", params: {} }],
      describe: (f) => ({
        title: "Relative hreflang URLs",
        message: `${f.hreflangRelativeCount} hreflang link(s) use relative URLs.`,
        observed: `${f.hreflangRelativeCount} relative href(s)`,
        expected: "Absolute URLs including scheme and host",
        recommendations: ["Output fully-qualified URLs in hreflang annotations."],
      }),
    },
  ],
};
