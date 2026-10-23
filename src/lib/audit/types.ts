// Shared audit types. No React, no I/O — safe to import from rules, server and UI.

export type Severity = "high" | "medium" | "low";

/** Serializable facts a rule observed on a page. Deterministic input to acceptance criteria. */
export type Facts = Record<string, string | number | boolean | null>;

/**
 * What the site owner intends for a page. Some rules cannot be judged without these,
 * and Site Sentry never guesses them.
 */
export interface PageExpectations {
  /** Absolute URL the page's rel=canonical must point to. */
  canonicalUrl?: string;
  /** Whether the page is meant to be indexed by search engines. */
  indexability?: "index" | "noindex";
}
export type ExpectationKey = keyof PageExpectations;

/**
 * A stored, data-only acceptance criterion. `id` selects a deterministic evaluator and
 * `params` freezes its thresholds at the time the finding was created, so later code or
 * configuration changes never alter what an existing finding is judged against.
 */
export interface AcceptanceCriterion {
  id: string;
  description: string;
  params: Record<string, string | number>;
}

export interface CriterionResult {
  id: string;
  description: string;
  passed: boolean;
  /** Human-readable value the evaluator actually saw. */
  actual: string;
}

export interface Evidence {
  /** Raw HTML/header excerpts the finding is based on. */
  snippets: string[];
  /** Structured facts the rule observed. */
  facts: Facts;
}

export interface Finding {
  /** Specific check that fired, e.g. "title/too-long". */
  ruleCode: string;
  /** Rule group, e.g. "title". */
  ruleId: string;
  pageUrl: string;
  severity: Severity;
  title: string;
  message: string;
  /** What we saw, verbatim where possible. */
  observed: string;
  /** The condition the page should meet. */
  expected: string;
  evidence: Evidence;
  recommendations: string[];
  acceptanceCriteria: AcceptanceCriterion[];
}

export type RuleStatus = "pass" | "fail" | "needs_config";

export interface RuleResult {
  ruleId: string;
  name: string;
  status: RuleStatus;
  findings: Finding[];
  facts: Facts;
  snippets: string[];
  /** Expectations the user must configure before this rule can be judged. */
  missingExpectations: ExpectationKey[];
}

export interface RedirectHop {
  url: string;
  status: number;
}

/**
 * `live`   — fetched from the public web during this request.
 * `sample` — computed from bundled fixture HTML; never presented as a real site.
 */
export type AuditSource = "live" | "sample";

export interface AuditResult {
  id: string;
  source: AuditSource;
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number;
  redirectChain: RedirectHop[];
  fetchedAt: string;
  bytes: number;
  truncated: boolean;
  expectations: PageExpectations;
  rules: RuleResult[];
}

/** A point-in-time capture of the facts relevant to one finding. */
export interface Observation {
  capturedAt: string;
  source: AuditSource;
  finalUrl: string;
  httpStatus: number;
  facts: Facts;
  snippets: string[];
}

export type VerificationOutcome = "resolved" | "still_failing" | "inconclusive";

export interface VerificationAttempt {
  id: string;
  at: string;
  outcome: VerificationOutcome;
  reason: string;
  criteria: CriterionResult[];
  /** Null when the page could not be observed (inconclusive fetch). */
  observation: Observation | null;
  error?: { code: string; message: string };
}

export type TrackedStatus = "open" | "resolved";

export interface TrackedFinding {
  id: string;
  createdAt: string;
  auditId: string;
  source: AuditSource;
  status: TrackedStatus;
  resolvedAt: string | null;
  /** The finding exactly as originally detected. Never mutated. */
  finding: Finding;
  /** The page state at detection time. Never mutated. */
  originalObservation: Observation;
  /** Expectations in force when the finding was created. */
  expectations: PageExpectations;
  attempts: VerificationAttempt[];
}
