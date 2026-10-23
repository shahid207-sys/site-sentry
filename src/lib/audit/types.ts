// Shared audit types. No React, no I/O — safe to import from rules, server and UI.

export type Severity = "high" | "medium" | "low";

export interface Evidence {
  /** What we actually saw in the document, verbatim where possible. */
  observed: string;
  /** What the rule expects to see. */
  expected: string;
  /** Raw HTML excerpt(s) the finding is based on. */
  snippets: string[];
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  title: string;
  message: string;
  evidence: Evidence;
  recommendation: string;
}

export interface RuleResult {
  ruleId: string;
  name: string;
  passed: boolean;
  findings: Finding[];
}

export interface RedirectHop {
  url: string;
  status: number;
}

/**
 * `live`   — fetched from the public web during this request.
 * `sample` — computed from the bundled fixture HTML; never presented as a real site.
 */
export type AuditSource = "live" | "sample";

export interface AuditResult {
  source: AuditSource;
  requestedUrl: string;
  finalUrl: string;
  httpStatus: number;
  redirectChain: RedirectHop[];
  fetchedAt: string;
  bytes: number;
  truncated: boolean;
  rules: RuleResult[];
}
