import type { TrackedFinding } from "../audit/types";

/** Ticket body to paste into Jira, Linear, GitHub, etc. Pure: safe on client and server. */
export function fixTaskToMarkdown(t: TrackedFinding): string {
  const f = t.finding;
  const lines = [
    `## [${f.severity.toUpperCase()}] ${f.title}`,
    "",
    t.source === "sample" ? "> SAMPLE DATA: generated from the Site Sentry demo fixture, not a real site.\n" : "",
    `**Page:** ${f.pageUrl}`,
    `**Rule:** \`${f.ruleCode}\``,
    `**Status:** ${t.status}${t.resolvedAt ? ` (verified ${t.resolvedAt})` : ""}`,
    "",
    `**Observed:** ${f.observed}`,
    `**Expected:** ${f.expected}`,
  ];
  if (f.evidence.snippets.length) lines.push("", "**Evidence:**", "```html", ...f.evidence.snippets, "```");
  lines.push("", "**Recommended fix:**", ...f.recommendations.map((r) => `- ${r}`));
  lines.push("", "**Acceptance criteria** (all must pass on re-scan):", ...f.acceptanceCriteria.map((c) => `- [ ] ${c.description}`));
  lines.push("", "**Verify:** deploy the fix, then click Re-scan in Site Sentry.");
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}
