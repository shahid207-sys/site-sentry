// Custom-profile include/exclude rules are user-written regular expressions, run by the worker against every URL it
// discovers. JavaScript's regex engine backtracks, so a pattern such as (a+)+$ can take exponential time on one URL
// and stall a worker. Rules are capped at MAX_RULE_LENGTH and rejected when safe-regex2 finds nested quantifiers
// (star height above 1) or an excessive repetition count. The check errs both ways:
// - It counts ? as a repetition, so the harmless (en/.*)? is refused too; the message shows the rewrite.
// - It misses overlapping alternation: ^(a|a)*$ passes.
// Kept out of profiles.ts so the client bundle does not carry the checker.
import safeRegex from "safe-regex2";
import { MAX_URL_LENGTH } from "./normalise";
import { MAX_RULE_LENGTH } from "./profiles";

/**
 * Second ReDoS guard: the longest input a rule is ever run against. Normalised URLs are already capped at this length;
 * the check here keeps that true for any caller. Longer input is not matched (and not truncated, which could make an
 * include rule match a URL it should not).
 */
export const MAX_MATCH_INPUT = MAX_URL_LENGTH;

/** Error code a crawl fails with when one of its stored rules is refused (crawls.error.code, shown on the audit). */
export const SCOPE_RULE_INVALID = "scope_rule_invalid";

export class ScopeRuleError extends Error {
  readonly code = SCOPE_RULE_INVALID;
  constructor(
    readonly kind: "Include" | "Exclude",
    readonly index: number,
    readonly rule: string,
    readonly problem: string,
  ) {
    super(`${kind} rule ${index + 1} ${JSON.stringify(rule.length > 80 ? `${rule.slice(0, 80)}…` : rule)} is refused: ${problem}`);
  }
}

/** Why a regex is unusable as a scope rule, or null. Patterns are compiled without flags, so matching is case-sensitive. */
export function regexProblem(source: string): string | null {
  if (!source) return "Empty pattern.";
  if (source.length > MAX_RULE_LENGTH) return `Longer than ${MAX_RULE_LENGTH} characters.`;
  try {
    new RegExp(source);
  } catch (e) {
    return (e as Error).message;
  }
  if (!safeRegex(source)) {
    return "Refused: this pattern can take exponential time to match (a repeated or optional group that contains another repetition, such as (a+)+ or (x.*)?). Rewrite it without nesting, e.g. (x.*)?$ as ($|x).";
  }
  return null;
}

/**
 * Apply compiled include/exclude rules to a URL: an excluded_by_rule reason, or null when the rules let it through.
 * Input longer than MAX_MATCH_INPUT is excluded without running any rule.
 */
export function ruleVerdict(url: string, include: [string, RegExp][], exclude: [string, RegExp][]): string | null {
  if (!include.length && !exclude.length) return null;
  if (url.length > MAX_MATCH_INPUT) return `Longer than ${MAX_MATCH_INPUT} characters; scope rules are not run on it.`;
  const excluded = exclude.find(([, re]) => re.test(url));
  if (excluded) return `Matches the exclude rule "${excluded[0]}".`;
  if (include.length && !include.some(([, re]) => re.test(url))) return `Matches none of the ${include.length} include rule(s).`;
  return null;
}

/** Compile scope rules, throwing ScopeRuleError on the first unusable one (rules stored before validation tightened, or edited rows). */
export function compileRules(list: string[] = [], kind: "Include" | "Exclude" = "Include"): [string, RegExp][] {
  return list.map((s, i): [string, RegExp] => {
    const problem = regexProblem(s);
    if (problem) throw new ScopeRuleError(kind, i, s, problem);
    return [s, new RegExp(s)];
  });
}
