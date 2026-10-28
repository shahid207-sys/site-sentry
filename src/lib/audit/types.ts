// Shared audit types. No React, no I/O — safe to import from rules, server and UI.

export type Severity = "high" | "medium" | "low";

/**
 * What kind of statement a finding makes. Kept separate from severity:
 * - defect:      a verified technical problem (e.g. HTTP 404 on a linked page)
 * - warning:     a likely problem or a convention breach that merits review
 * - opportunity: not wrong, but improvable (e.g. internal links that go through a redirect)
 * - observation: something worth knowing that may be intentional (e.g. a cross-URL canonical)
 */
export type FindingKind = "defect" | "warning" | "opportunity" | "observation";

/**
 * How sure Site Sentry is of the *observation*, separately from how much it matters.
 * - verified:     measured directly and deterministically from the response
 * - heuristic:    based on a threshold or convention (e.g. word count, title length)
 * - needs_review: correct measurement, but only a person can say whether it is a problem
 */
export type Certainty = "verified" | "heuristic" | "needs_review";

export type RuleCategory =
  | "crawlability"
  | "indexability"
  | "metadata"
  | "links"
  | "structured-data"
  | "images"
  | "content"
  | "international"
  | "social";

export const RULE_CATEGORIES: { id: RuleCategory; label: string; description: string }[] = [
  { id: "crawlability", label: "Crawlability & HTTP", description: "Status codes, redirects, robots.txt and sitemaps" },
  { id: "indexability", label: "Indexability", description: "Robots directives, canonical tags and intended indexing" },
  { id: "metadata", label: "Metadata & structure", description: "Titles, meta descriptions and headings" },
  { id: "links", label: "Internal links", description: "Broken and redirected internal links, orphan candidates" },
  { id: "structured-data", label: "Structured data", description: "JSON-LD syntax and basic required properties" },
  { id: "images", label: "Images", description: "Alt attributes, dimensions and broken internal images" },
  { id: "content", label: "Content (heuristic)", description: "Word counts and duplicate titles/descriptions" },
  { id: "international", label: "Language & hreflang", description: "html lang and hreflang annotations" },
  { id: "social", label: "Social metadata", description: "Open Graph and Twitter card tags" },
];

/** Serializable facts a rule observed on a page. Deterministic input to acceptance criteria. */
export type Facts = Record<string, string | number | boolean | null>;

/**
 * What the site owner intends for a page. Some checks cannot be judged without these,
 * and Site Sentry never guesses them.
 */
export interface PageExpectations {
  /** Absolute URL the page's rel=canonical must point to. */
  canonicalUrl?: string;
  /** Whether the page is meant to be indexed by search engines. */
  indexability?: "index" | "noindex";
  /** The page is on the site's list of important URLs. */
  important?: boolean;
}
export type ExpectationKey = keyof PageExpectations;

/** Workspace-level rule configuration. Thresholds are frozen into criteria when a finding is created. */
export interface RuleConfig {
  /** Main-content word count under which a page is flagged as possibly thin (heuristic). */
  thinContentWords: number;
  /** Whether more than one <h1> is reported. Multiple h1s are valid HTML; this is a convention. */
  multipleH1: "warn" | "ignore";
}
export const DEFAULT_RULE_CONFIG: RuleConfig = { thinContentWords: 250, multipleH1: "warn" };

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
  /** Raw HTML/header excerpts the finding is based on. Always rendered as text, never as HTML. */
  snippets: string[];
  /** Structured facts the rule observed. */
  facts: Facts;
  /** Affected URLs for findings that span pages (e.g. pages sharing a title, pages linking to a 404). */
  urls?: { url: string; detail: string }[];
}

/**
 * Which URLs a finding depends on. Comparison only calls a finding "resolved" when a later audit
 * successfully re-inspected its whole scope.
 */
export type FindingScope =
  | { kind: "page"; url: string }
  | { kind: "pages"; urls: string[] }
  | { kind: "target"; url: string; sources: string[] }
  | { kind: "site"; check: "robots" | "sitemap" | "graph" };

/**
 * How a fix can be verified:
 * - page:    re-fetch the page and evaluate the rule's frozen criteria
 * - site:    re-fetch the specific URLs the finding depends on (robots.txt, sitemap, link target…)
 * - reaudit: only a new crawl can tell (e.g. orphan candidates need the whole link graph)
 */
export type VerifyMode = "page" | "site" | "reaudit";

export interface Finding {
  /** Specific check that fired, e.g. "title/too-long". Stable identifier. */
  ruleCode: string;
  /** Rule group, e.g. "title". */
  ruleId: string;
  category: RuleCategory;
  pageUrl: string;
  severity: Severity;
  kind: FindingKind;
  certainty: Certainty;
  title: string;
  message: string;
  /** What we saw, verbatim where possible. (Observation) */
  observed: string;
  /** The condition the page should meet. */
  expected: string;
  /** Why this merits review. Never claims a ranking effect. */
  why: string;
  /** Likely explanation, phrased as a hypothesis. Optional. (Diagnosis) */
  diagnosis?: string;
  evidence: Evidence;
  /** Proposed actions requiring judgment. (Recommendation) */
  recommendations: string[];
  acceptanceCriteria: AcceptanceCriterion[];
  scope: FindingScope;
  verify: VerifyMode;
  /** Expectation keys that shaped this finding; part of its fingerprint. */
  expectationKey?: string;
}

export interface Priority {
  /** P1 is the most urgent. */
  level: 1 | 2 | 3 | 4;
  score: number;
  /** Severity after workspace overrides. */
  severity: Severity;
  /** Every factor that contributed, in order, e.g. "Base severity: high (+3)". */
  reasons: string[];
}

/** A finding as stored on an audit: identity and priority added. */
export interface AuditFinding extends Finding {
  fingerprint: string;
  auditId: string;
  priority: Priority;
}

export type RuleStatus = "pass" | "fail" | "needs_config" | "skipped";

export interface RuleResult {
  ruleId: string;
  name: string;
  category: RuleCategory;
  status: RuleStatus;
  findings: Finding[];
  facts: Facts;
  snippets: string[];
  /** Expectations the user must configure before every check of this rule can be judged. */
  missingExpectations: ExpectationKey[];
  /**
   * Check codes actually evaluated on this page (not switched off, not waiting on configuration).
   * Absent on snapshots recorded before this field existed; see `ranCheck` in compare.ts.
   */
  checked?: string[];
}

export interface RedirectHop {
  url: string;
  status: number;
}

/**
 * `live`   — fetched from the public web.
 * `sample` — computed from bundled fixture sites; never presented as a real site.
 */
export type AuditSource = "live" | "sample";

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

/** Body of one verification of one finding. */
export interface ItemVerification {
  fingerprint: string;
  outcome: VerificationOutcome;
  reason: string;
  criteria: CriterionResult[];
  /** Null when the page could not be observed (inconclusive fetch). */
  observation: Observation | null;
  error?: { code: string; message: string };
}
