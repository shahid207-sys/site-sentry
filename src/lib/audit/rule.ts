import type { Doc } from "./parse";
import type {
  AcceptanceCriterion,
  Certainty,
  CriterionResult,
  ExpectationKey,
  Facts,
  Finding,
  FindingKind,
  PageExpectations,
  RedirectHop,
  RuleCategory,
  RuleConfig,
  RuleResult,
  Severity,
} from "./types";

export interface ResponseInfo {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirectChain: RedirectHop[];
  contentType: string;
}

export interface PageContext {
  /** Parsed document; null when the response was not an inspectable HTML page (error status, PDF…). */
  $: Doc | null;
  /** The URL the document was served from (after redirects). */
  pageUrl: string;
  /** Lower-cased response header names. Only headers rules need are kept. */
  headers: Record<string, string>;
  response: ResponseInfo;
  config: RuleConfig;
}

/** Context for rules that read the document; evaluateRule guarantees `$` is set for them. */
export type HtmlContext = PageContext & { $: Doc };

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
  /** Hedged, likely explanation. Never stated as fact. */
  diagnosis?: string;
}

export interface CheckDef<F extends Facts> {
  code: string;
  severity: Severity;
  kind: FindingKind;
  certainty: Certainty;
  /** Why this merits review. */
  why: string;
  /** Expectations this check needs; it is skipped (and the rule reports needs_config) until they are set. */
  needs?: ExpectationKey[];
  /** Checks that a workspace setting can switch off. */
  enabled?(config: RuleConfig): boolean;
  /** Detection: does this problem exist on the observed page? */
  detect(facts: F, exp: PageExpectations, config: RuleConfig): boolean;
  /** Criteria that must ALL pass for the problem to count as fixed. Params are frozen at creation. */
  criteria(exp: PageExpectations, config: RuleConfig): AcceptanceCriterion[];
  describe(facts: F, exp: PageExpectations, config: RuleConfig): CheckDescription;
  /** Part of the fingerprint when the finding depends on configured intent (e.g. the expected canonical). */
  expectationKey?(exp: PageExpectations): string;
}

export interface RuleDef<F extends Facts> {
  id: string;
  name: string;
  category: RuleCategory;
  /** False for rules that judge the HTTP response itself and also run on error pages. Default true. */
  requiresHtml?: boolean;
  /** When set, the verifier judges redirects/status itself instead of treating them as "page unavailable". */
  judgesResponse?: boolean;
  /** Which URL findings are about: the served page (default) or the URL that was requested (redirect/status rules). */
  subject?: "final" | "requested";
  observe(ctx: HtmlContext): { facts: F; snippets: string[] };
  checks: CheckDef<F>[];
}

/** Observe with a rule, handling rules that need HTML. Returns null when the rule cannot run on this response. */
export function observeRule<F extends Facts>(rule: RuleDef<F>, ctx: PageContext): { facts: F; snippets: string[] } | null {
  if (rule.requiresHtml !== false && !ctx.$) return null;
  return rule.observe(ctx as HtmlContext);
}

export function evaluateRule<F extends Facts>(
  rule: RuleDef<F>,
  ctx: PageContext,
  exp: PageExpectations,
): RuleResult {
  const base = { ruleId: rule.id, name: rule.name, category: rule.category };
  const observed = observeRule(rule, ctx);
  if (!observed) {
    return { ...base, status: "skipped", findings: [], facts: {}, snippets: [], missingExpectations: [], checked: [] };
  }
  const { facts, snippets } = observed;
  const missing = new Set<ExpectationKey>();
  const findings: Finding[] = [];
  const checked: string[] = [];
  const pageUrl = rule.subject === "requested" ? ctx.response.requestedUrl : ctx.pageUrl;

  for (const check of rule.checks) {
    if (check.enabled && !check.enabled(ctx.config)) continue;
    const unmet = (check.needs ?? []).filter((k) => exp[k] === undefined);
    if (unmet.length) {
      // Never guess intent: skip, and ask for configuration instead.
      unmet.forEach((k) => missing.add(k));
      continue;
    }
    checked.push(check.code);
    if (!check.detect(facts, exp, ctx.config)) continue;
    const d = check.describe(facts, exp, ctx.config);
    findings.push({
      ruleCode: check.code,
      ruleId: rule.id,
      category: rule.category,
      pageUrl,
      severity: check.severity,
      kind: check.kind,
      certainty: check.certainty,
      title: d.title,
      message: d.message,
      observed: d.observed,
      expected: d.expected,
      why: check.why,
      diagnosis: d.diagnosis,
      evidence: { snippets, facts },
      recommendations: d.recommendations,
      acceptanceCriteria: check.criteria(exp, ctx.config),
      scope: { kind: "page", url: pageUrl },
      verify: "page",
      expectationKey: check.expectationKey?.(exp),
    });
  }

  return {
    ...base,
    status: findings.length ? "fail" : missing.size ? "needs_config" : "pass",
    findings,
    facts,
    snippets,
    missingExpectations: [...missing],
    checked,
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

// ---------- small helpers shared by rules ----------

export const num = (v: unknown) => (typeof v === "number" ? v : null);
export const str = (v: unknown) => (typeof v === "string" ? v : null);

/** Evaluator: a numeric fact must be at most params.max (default 0). */
export const atMost =
  (fact: string, label: string): CriterionEvaluator =>
  (f, p) => {
    const v = num(f[fact]);
    const max = Number(p.max ?? 0);
    return { passed: v !== null && v <= max, actual: `${v ?? "unknown"} ${label}` };
  };

/** Evaluator: a boolean fact must equal params.equals ("true"/"false"). */
export const isTrue =
  (fact: string, describe: (v: unknown) => string): CriterionEvaluator =>
  (f) => ({ passed: f[fact] === true, actual: describe(f[fact]) });

export const isFalse =
  (fact: string, describe: (v: unknown) => string): CriterionEvaluator =>
  (f) => ({ passed: f[fact] === false, actual: describe(f[fact]) });
