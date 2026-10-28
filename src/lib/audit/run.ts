import { parseHtml } from "./parse";
import { evaluateRule, type CriterionEvaluator, type PageContext, type ResponseInfo, type RuleDef } from "./rule";
import { canonicalEvaluators, canonicalRule } from "./rules/canonical";
import { contentEvaluators, contentRule } from "./rules/content";
import { headingEvaluators, headingsRule } from "./rules/headings";
import { httpEvaluators, httpRule } from "./rules/http";
import { imageEvaluators, imagesRule } from "./rules/images";
import { indexabilityEvaluators, indexabilityRule } from "./rules/indexability";
import { internationalEvaluators, internationalRule } from "./rules/international";
import { descriptionEvaluators, metaDescriptionRule } from "./rules/meta-description";
import { socialEvaluators, socialRule } from "./rules/social";
import { structuredDataEvaluators, structuredDataRule } from "./rules/structured-data";
import { titleEvaluators, titleRule } from "./rules/title";
import { DEFAULT_RULE_CONFIG, type Facts, type PageExpectations, type RuleCategory, type RuleConfig, type RuleResult } from "./types";

/** Registry of deterministic page rules. Add new rules here. */
export const RULES: RuleDef<Facts>[] = [
  httpRule,
  titleRule,
  metaDescriptionRule,
  headingsRule,
  canonicalRule,
  indexabilityRule,
  internationalRule,
  socialRule,
  structuredDataRule,
  imagesRule,
  contentRule,
] as unknown as RuleDef<Facts>[];

/** Every criterion id a stored finding may reference, mapped to its evaluator. */
export const CRITERION_EVALUATORS: Record<string, CriterionEvaluator> = {
  ...httpEvaluators,
  ...titleEvaluators,
  ...descriptionEvaluators,
  ...headingEvaluators,
  ...canonicalEvaluators,
  ...indexabilityEvaluators,
  ...internationalEvaluators,
  ...socialEvaluators,
  ...structuredDataEvaluators,
  ...imageEvaluators,
  ...contentEvaluators,
};

export interface PageInput {
  /** Null when the response was not inspectable HTML; only response-level rules then run. */
  html: string | null;
  pageUrl: string;
  headers?: Record<string, string>;
  response?: Partial<ResponseInfo>;
}

export function pageContext(page: PageInput, config: RuleConfig = DEFAULT_RULE_CONFIG): PageContext {
  return {
    $: page.html === null ? null : parseHtml(page.html),
    pageUrl: page.pageUrl,
    headers: page.headers ?? {},
    config,
    response: {
      requestedUrl: page.pageUrl,
      finalUrl: page.pageUrl,
      status: 200,
      redirectChain: [],
      contentType: "text/html",
      ...page.response,
    },
  };
}

/** Pure: page in, rule results out. No network, no clock, no randomness. */
export function runRules(
  page: PageInput,
  exp: PageExpectations = {},
  opts: { config?: RuleConfig; categories?: RuleCategory[]; rules?: RuleDef<Facts>[] } = {},
): RuleResult[] {
  const ctx = pageContext(page, opts.config);
  const rules = (opts.rules ?? RULES).filter((r) => !opts.categories || opts.categories.includes(r.category));
  return rules.map((rule) => evaluateRule(rule, ctx, exp));
}

export function ruleById(id: string): RuleDef<Facts> | undefined {
  return RULES.find((r) => r.id === id);
}
