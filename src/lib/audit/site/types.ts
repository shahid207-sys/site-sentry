import type { Fetcher } from "../../fetch/safe-fetch";
import type { LinkCheck, PageSnapshot, RobotsSnapshot, SitemapSnapshot } from "../../model";
import type { Certainty, Finding, FindingKind, ItemVerification, PageExpectations, RuleCategory, RuleConfig, Severity } from "../types";

/** Everything a cross-page rule may read about one finished crawl. */
export interface SiteContext {
  origin: string;
  pages: PageSnapshot[];
  linkChecks: Record<string, LinkCheck>;
  robots: RobotsSnapshot | null;
  sitemap: SitemapSnapshot | null;
  /** Configured intent by normalised URL (only important URLs). */
  intents: Record<string, PageExpectations>;
  config: RuleConfig;
  /** The crawl followed links and finished its frontier, so inbound-link counts are meaningful. */
  graphComplete: boolean;
  maxDepth: number;
}

export interface SiteCheckMeta {
  code: string;
  severity: Severity;
  kind: FindingKind;
  certainty: Certainty;
  why: string;
}

export interface VerifyEnv {
  fetch: Fetcher;
  source: "live" | "sample";
  now: () => Date;
  config: RuleConfig;
  origin: string;
}

export type VerifyBody = Omit<ItemVerification, "fingerprint">;

export interface SiteRule {
  id: string;
  name: string;
  category: RuleCategory;
  checks: SiteCheckMeta[];
  analyze(ctx: SiteContext): Finding[];
  /** Re-check the specific URLs a finding depends on. Absent for reaudit-only checks. */
  verify?(finding: Finding, env: VerifyEnv): Promise<VerifyBody>;
}

/** Build a site finding from check metadata. */
export function siteFinding(
  rule: Pick<SiteRule, "id" | "category">,
  meta: SiteCheckMeta,
  f: Omit<Finding, "ruleCode" | "ruleId" | "category" | "severity" | "kind" | "certainty" | "why">,
): Finding {
  return { ruleCode: meta.code, ruleId: rule.id, category: rule.category, severity: meta.severity, kind: meta.kind, certainty: meta.certainty, why: meta.why, ...f };
}

export const inconclusive = (reason: string, error?: { code: string; message: string }): VerifyBody => ({
  outcome: "inconclusive",
  reason,
  criteria: [],
  observation: null,
  error,
});
