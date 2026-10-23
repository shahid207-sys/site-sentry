import type { AuditResult, Finding } from "../audit/types";

export interface FixTask {
  id: string;
  ruleId: string;
  title: string;
  pageUrl: string;
  source: AuditResult["source"];
  severity: Finding["severity"];
  recommendation: string;
  evidence: Finding["evidence"];
  status: "open" | "done";
}

/** One task per (page, rule) — creating it twice returns the same id. */
export function fixTaskId(audit: AuditResult, finding: Finding): string {
  return `${audit.finalUrl}::${finding.ruleId}`;
}

export function createFixTask(audit: AuditResult, finding: Finding): FixTask {
  return {
    id: fixTaskId(audit, finding),
    ruleId: finding.ruleId,
    title: finding.title,
    pageUrl: audit.finalUrl,
    source: audit.source,
    severity: finding.severity,
    recommendation: finding.recommendation,
    evidence: finding.evidence,
    status: "open",
  };
}

/** Plain-text ticket body to paste into Jira, Linear, GitHub, etc. */
export function fixTaskToMarkdown(task: FixTask): string {
  const lines = [
    `## [${task.severity.toUpperCase()}] ${task.title}`,
    "",
    task.source === "sample" ? "> SAMPLE DATA: generated from the Site Sentry demo fixture, not a real site." : "",
    `**Page:** ${task.pageUrl}`,
    `**Rule:** \`${task.ruleId}\``,
    "",
    `**Observed:** ${task.evidence.observed}`,
    `**Expected:** ${task.evidence.expected}`,
  ];
  if (task.evidence.snippets.length) {
    lines.push("", "**Evidence:**", "```html", ...task.evidence.snippets, "```");
  }
  lines.push("", `**Fix:** ${task.recommendation}`, "", "**Verify:** re-run the Site Sentry audit on this URL and confirm this finding is gone.");
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
