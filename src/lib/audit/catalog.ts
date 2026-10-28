// Catalogue of every check: used by Settings (severity overrides), filters and documentation. Pure.
import { RULES } from "./run";
import { SITE_RULES } from "./site";
import type { Certainty, FindingKind, RuleCategory, Severity } from "./types";

export interface CheckInfo {
  code: string;
  ruleId: string;
  ruleName: string;
  category: RuleCategory;
  severity: Severity;
  kind: FindingKind;
  certainty: Certainty;
  why: string;
  needsConfig: boolean;
  scope: "page" | "site";
}

export const CHECKS: CheckInfo[] = [
  ...RULES.flatMap((r) =>
    r.checks.map((c) => ({
      code: c.code,
      ruleId: r.id,
      ruleName: r.name,
      category: r.category,
      severity: c.severity,
      kind: c.kind,
      certainty: c.certainty,
      why: c.why,
      needsConfig: !!c.needs?.length && !c.needs.every((n) => n === "important"),
      scope: "page" as const,
    })),
  ),
  ...SITE_RULES.flatMap((r) =>
    r.checks.map((c) => ({
      code: c.code,
      ruleId: r.id,
      ruleName: r.name,
      category: r.category,
      severity: c.severity,
      kind: c.kind,
      certainty: c.certainty,
      why: c.why,
      needsConfig: c.code === "robots/blocks-important",
      scope: "site" as const,
    })),
  ),
];

export const ALL_CHECK_CODES = new Set(CHECKS.map((c) => c.code));
export const checkInfo = (code: string) => CHECKS.find((c) => c.code === code);
