import { normalizePageUrl } from "../crawl/url";
import type { Finding, Priority, Severity } from "./types";

export interface PriorityContext {
  /** Base severity overrides by rule code (workspace settings). */
  severityOverrides: Record<string, Severity>;
  /** Normalised URLs on the site's important-URL list. */
  importantUrls: Set<string>;
  /** The site's homepage, normalised. */
  homepage: string | null;
}

const BASE: Record<Severity, number> = { high: 3, medium: 2, low: 1 };

/** URLs a finding affects, for scope and importance. */
export function affectedUrls(f: Finding): string[] {
  switch (f.scope.kind) {
    case "page":
      return [f.scope.url];
    case "pages":
      return f.scope.urls;
    case "target":
      return [f.scope.url, ...f.scope.sources];
    case "site":
      return f.evidence.urls?.map((u) => u.url) ?? [f.pageUrl];
  }
}

/**
 * Deterministic priority with a written explanation. Severity (how much it matters) and certainty
 * (how sure we are) are scored separately and both shown, so a heuristic finding never outranks a
 * verified defect of the same severity.
 */
export function prioritize(f: Finding, ctx: PriorityContext): Priority {
  const reasons: string[] = [];
  const override = ctx.severityOverrides[f.ruleCode];
  const severity = override ?? f.severity;
  let score = BASE[severity];
  reasons.push(
    override && override !== f.severity
      ? `Base severity ${severity} (workspace override of ${f.severity}) +${BASE[severity]}`
      : `Base severity ${severity} +${BASE[severity]}`,
  );

  const urls = affectedUrls(f).map((u) => normalizePageUrl(u) ?? u);
  const important = urls.filter((u) => ctx.importantUrls.has(u));
  if (important.length) {
    score += 1;
    reasons.push(`Affects ${important.length === 1 ? "an important URL" : `${important.length} important URLs`} +1`);
  } else if (ctx.homepage && urls.includes(ctx.homepage)) {
    score += 0.5;
    reasons.push("Affects the homepage +0.5");
  }

  const pageCount = new Set(urls).size;
  if (pageCount >= 5) {
    score += 1;
    reasons.push(`Spans ${pageCount} URLs +1`);
  } else if (pageCount >= 2) {
    score += 0.5;
    reasons.push(`Spans ${pageCount} URLs +0.5`);
  }

  if (f.certainty === "heuristic") {
    score -= 1;
    reasons.push("Heuristic threshold, not a verified defect −1");
  } else if (f.certainty === "needs_review") {
    score -= 1;
    reasons.push("May be intentional; needs human review −1");
  }
  if (f.kind === "opportunity" || f.kind === "observation") {
    score -= 0.5;
    reasons.push(`${f.kind === "opportunity" ? "Improvement opportunity" : "Observation"}, not a defect −0.5`);
  }

  const level: Priority["level"] = score >= 4 ? 1 : score >= 3 ? 2 : score >= 1.5 ? 3 : 4;
  return { level, score, severity, reasons };
}
