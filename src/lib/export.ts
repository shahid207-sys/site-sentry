// CSV and JSON exports of audit findings. Pure.
import type { ChangeKind } from "./audit/compare";
import type { AuditFinding } from "./audit/types";
import type { AuditDetail } from "./views";

/**
 * Escape one CSV cell. Cells a spreadsheet would treat as a formula (= + - @, tab, CR) are prefixed
 * with an apostrophe, because page titles and URLs come from untrusted websites.
 */
export function csvCell(value: unknown): string {
  let s = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_COLUMNS = [
  "priority",
  "severity",
  "certainty",
  "kind",
  "rule_code",
  "category",
  "title",
  "page_url",
  "observed",
  "expected",
  "change",
  "affected_urls",
  "recommendation",
  "acceptance_criteria",
  "fingerprint",
] as const;

export function findingsToCsv(findings: AuditFinding[], changes: Record<string, ChangeKind> | null): string {
  const rows = findings.map((f) => [
    `P${f.priority.level}`,
    f.priority.severity,
    f.certainty,
    f.kind,
    f.ruleCode,
    f.category,
    f.title,
    f.pageUrl,
    f.observed,
    f.expected,
    changes?.[f.fingerprint] ?? "",
    (f.evidence.urls ?? []).map((u) => u.url).join(" "),
    f.recommendations.join(" | "),
    f.acceptanceCriteria.map((c) => c.description).join(" | "),
    f.fingerprint,
  ]);
  // BOM so Excel opens UTF-8 correctly; CRLF per RFC 4180.
  return "﻿" + [CSV_COLUMNS as readonly string[], ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

export function auditToJson(detail: AuditDetail, findings: AuditFinding[], filter: Record<string, unknown>): string {
  const { audit, site } = detail;
  return JSON.stringify(
    {
      exportedBy: "SiteSentry",
      schema: "site-sentry.audit-export/1",
      source: audit.source,
      sampleData: audit.source === "sample",
      site: { name: site.name, origin: site.origin },
      audit: {
        id: audit.id,
        status: audit.status,
        startedAt: audit.startedAt,
        finishedAt: audit.finishedAt,
        config: audit.config,
        progress: audit.progress,
        coverage: audit.coverage,
        ruleConfig: audit.ruleConfig,
        error: audit.error ?? null,
      },
      filter,
      pages: detail.pages.map((p) => ({ url: p.url, finalUrl: p.finalUrl, outcome: p.outcome, status: p.status, fetchedAt: p.fetchedAt, redirectChain: p.redirectChain, error: p.error ?? null, summary: p.summary })),
      findings: findings.map((f) => ({ ...f, change: detail.changes?.[f.fingerprint] ?? null })),
    },
    null,
    2,
  );
}

/** A filesystem-safe export name, e.g. "northwind-outdoor-2026-10-15-findings.csv". */
export function exportName(siteName: string, at: string, suffix: string): string {
  const slug = siteName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "site";
  return `${slug}-${at.slice(0, 10)}-${suffix}`;
}
