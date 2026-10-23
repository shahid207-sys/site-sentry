import { parseHtml, type Doc } from "./parse";
import { checkTitle } from "./rules/title";
import type { RuleResult } from "./types";

export type Rule = ($: Doc) => RuleResult;

/** Registry of deterministic rules. Add new checks here. */
export const RULES: Rule[] = [checkTitle];

/** Pure: HTML in, rule results out. No network, no clock, no randomness. */
export function runRules(html: string, rules: Rule[] = RULES): RuleResult[] {
  const $ = parseHtml(html);
  return rules.map((rule) => rule($));
}
