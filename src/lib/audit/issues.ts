// Issue history across a site's audits, derived from immutable audit snapshots. Pure.
import type { AuditRun, PageSnapshot } from "../model";
import { coverageOf, isCovered } from "./compare";
import type { AuditFinding } from "./types";

export type IssueState = "open" | "resolved" | "unknown";

export interface IssueOccurrence {
  auditId: string;
  at: string;
  /** present: detected; absent: re-checked and not detected; unchecked: not re-examined. */
  state: "present" | "absent" | "unchecked";
  observed: string | null;
}

export interface Issue {
  fingerprint: string;
  siteId: string;
  /** The most recent detection. */
  latest: AuditFinding;
  state: IssueState;
  firstSeenAt: string;
  firstSeenAuditId: string;
  lastSeenAt: string;
  lastSeenAuditId: string;
  resolvedAt: string | null;
  /** Set when an issue that had been re-checked as absent was detected again. */
  regressedAt: string | null;
  /** True when the most recent audit did not re-examine this issue's scope. */
  stale: boolean;
  history: IssueOccurrence[];
}

export interface AuditBundle {
  audit: AuditRun;
  pages: PageSnapshot[];
  findings: AuditFinding[];
}

/** Audits that produced results, oldest first. Running and failed audits have no complete snapshot. */
export function finishedAudits<T extends { audit: AuditRun }>(bundles: T[]): T[] {
  return bundles
    .filter((b) => b.audit.status === "completed" || b.audit.status === "partial" || b.audit.status === "cancelled")
    .sort((a, b) => a.audit.startedAt.localeCompare(b.audit.startedAt));
}

export function buildIssues(siteId: string, bundles: AuditBundle[]): Issue[] {
  const issues = new Map<string, Issue>();
  for (const { audit, pages, findings } of finishedAudits(bundles)) {
    if (audit.siteId !== siteId) continue;
    const at = audit.startedAt;
    const present = new Map(findings.map((f) => [f.fingerprint, f]));
    for (const f of findings) {
      const existing = issues.get(f.fingerprint);
      if (!existing) {
        issues.set(f.fingerprint, {
          fingerprint: f.fingerprint,
          siteId,
          latest: f,
          state: "open",
          firstSeenAt: at,
          firstSeenAuditId: audit.id,
          lastSeenAt: at,
          lastSeenAuditId: audit.id,
          resolvedAt: null,
          regressedAt: null,
          stale: false,
          history: [{ auditId: audit.id, at, state: "present", observed: f.observed }],
        });
        continue;
      }
      if (existing.state === "resolved") existing.regressedAt = at;
      existing.state = "open";
      existing.latest = f;
      existing.lastSeenAt = at;
      existing.lastSeenAuditId = audit.id;
      existing.resolvedAt = null;
      existing.stale = false;
      existing.history.push({ auditId: audit.id, at, state: "present", observed: f.observed });
    }
    const cov = coverageOf(audit, pages);
    for (const issue of issues.values()) {
      if (present.has(issue.fingerprint)) continue;
      const { covered } = isCovered(issue.latest, cov);
      issue.history.push({ auditId: audit.id, at, state: covered ? "absent" : "unchecked", observed: null });
      if (covered) {
        if (issue.state !== "resolved") issue.resolvedAt = at;
        issue.state = "resolved";
        issue.stale = false;
      } else {
        issue.stale = true;
      }
    }
  }
  return [...issues.values()].sort(
    (a, b) => (a.state === b.state ? 0 : a.state === "open" ? -1 : 1) || a.latest.priority.level - b.latest.priority.level || b.lastSeenAt.localeCompare(a.lastSeenAt),
  );
}
