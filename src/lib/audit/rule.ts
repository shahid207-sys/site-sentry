import type { Doc } from "./parse";
import type {
  AcceptanceCriterion,
  CriterionResult,
  ExpectationKey,
  Facts,
  Finding,
  PageExpectations,
  RuleResult,
  Severity,
} from "./types";

export interface PageContext {
  $: Doc;
  pageUrl: string;
  /** Lower-cased response header names. Only headers rules need are kept. */
  headers: Record<string, string>;
}

/**
 * Deterministic evaluator for a stored criterion. Receives the facts from a fresh observation
 * and the criterion's frozen params.
 */
export type CriterionEvaluator = (
  facts: Facts,
  params: AcceptanceCriterion["params"],
) => { passed: boolean; actual: string };

export interface CheckDescription {
  title: string;
  message: string;
  observed: string;
  expected: string;
  recommendations: string[];
}

export interface CheckDef<F extends Facts> {
  code: string;
  severity: Severity;
  /** Detection: does this problem exist on the observed page? */
  detect(facts: F, exp: PageExpectations): boolean;
  /** Criteria that must ALL pass for the problem to count as fixed. Params are frozen at creation. */
  criteria(exp: PageExpectations): AcceptanceCriterion[];
  describe(facts: F, exp: PageExpectations): CheckDescription;
}

export interface RuleDef<F extends Facts> {
  id: string;
  name: string;
  /** Expectations that must be configured before this rule can judge anything. */
  needs: ExpectationKey[];
  observe(ctx: PageContext): { facts: F; snippets: string[] };
  checks: CheckDef<F>[];
}

export function evaluateRule<F extends Facts>(
  rule: RuleDef<F>,
  ctx: PageContext,
  exp: PageExpectations,
): RuleResult {
  const { facts, snippets } = rule.observe(ctx);
  const missing = rule.needs.filter((k) => !exp[k]);
  if (missing.length > 0) {
    // Never guess intent: report what we saw and ask for configuration instead.
    return { ruleId: rule.id, name: rule.name, status: "needs_config", findings: [], facts, snippets, missingExpectations: missing };
  }

  const findings: Finding[] = rule.checks
    .filter((check) => check.detect(facts, exp))
    .map((check) => {
      const d = check.describe(facts, exp);
      return {
        ruleCode: check.code,
        ruleId: rule.id,
        pageUrl: ctx.pageUrl,
        severity: check.severity,
        title: d.title,
        message: d.message,
        observed: d.observed,
        expected: d.expected,
        evidence: { snippets, facts },
        recommendations: d.recommendations,
        acceptanceCriteria: check.criteria(exp),
      };
    });

  return {
    ruleId: rule.id,
    name: rule.name,
    status: findings.length ? "fail" : "pass",
    findings,
    facts,
    snippets,
    missingExpectations: [],
  };
}

/** Evaluate stored criteria against fresh facts. Unknown criterion ids make the result undecidable. */
export function evaluateCriteria(
  criteria: AcceptanceCriterion[],
  facts: Facts,
  evaluators: Record<string, CriterionEvaluator>,
): { results: CriterionResult[]; unknown: string[] } {
  const unknown: string[] = [];
  const results = criteria.map((c) => {
    const evaluate = evaluators[c.id];
    if (!evaluate) {
      unknown.push(c.id);
      return { id: c.id, description: c.description, passed: false, actual: "No evaluator for this criterion" };
    }
    return { id: c.id, description: c.description, ...evaluate(facts, c.params) };
  });
  return { results, unknown };
}
