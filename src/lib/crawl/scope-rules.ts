// Custom-profile include/exclude rules are user-written regular expressions, run by the worker against every URL it
// discovers. JavaScript's regex engine backtracks, so a pattern such as (a+)+$ can take exponential time on one URL
// and stall a worker. Rules are capped at MAX_RULE_LENGTH and rejected when safe-regex2 finds nested quantifiers
// (star height above 1) or an excessive repetition count. The check errs both ways:
// - It counts ? as a repetition, so the harmless (en/.*)? is refused too; the message shows the rewrite.
// - It misses overlapping alternation: ^(a|a)*$ passes.
// Kept out of profiles.ts so the client bundle does not carry the checker.
import safeRegex from "safe-regex2";
import { MAX_RULE_LENGTH } from "./profiles";

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

/** Compile scope rules, throwing on the first unusable one (rules stored before validation tightened, or edited rows). */
export function compileRules(list: string[] = []): [string, RegExp][] {
  return list.map((s): [string, RegExp] => {
    const problem = regexProblem(s);
    if (problem) throw new Error(`Scope rule ${JSON.stringify(s)} is unusable: ${problem}`);
    return [s, new RegExp(s)];
  });
}
