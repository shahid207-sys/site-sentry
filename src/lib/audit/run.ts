import { parseHtml } from "./parse";
import { evaluateRule, type CriterionEvaluator, type RuleDef } from "./rule";
import { canonicalEvaluators, canonicalRule } from "./rules/canonical";
import { indexabilityEvaluators, indexabilityRule } from "./rules/indexability";
import { titleEvaluators, titleRule } from "./rules/title";
import type { Facts, PageExpectations, RuleResult } from "./types";

/** Registry of deterministic rules. Add new rules here. */
export const RULES: RuleDef<Facts>[] = [titleRule, canonicalRule, indexabilityRule];

/** Every criterion id a stored finding may reference, mapped to its evaluator. */
export const CRITERION_EVALUATORS: Record<string, CriterionEvaluator> = {
  ...titleEvaluators,
  ...canonicalEvaluators,
  ...indexabilityEvaluators,
};

export interface PageInput {
  html: string;
  pageUrl: string;
  headers?: Record<string, string>;
}

/** Pure: page in, rule results out. No network, no clock, no randomness. */
export function runRules(page: PageInput, exp: PageExpectations = {}, rules: RuleDef<Facts>[] = RULES): RuleResult[] {
  const ctx = { $: parseHtml(page.html), pageUrl: page.pageUrl, headers: page.headers ?? {} };
  return rules.map((rule) => evaluateRule(rule, ctx, exp));
}

export function ruleById(id: string): RuleDef<Facts> | undefined {
  return RULES.find((r) => r.id === id);
}
