// Groups issue instances by site and check, so 25 pages with the same defect read as one problem with
// 25 affected pages. Presentation only: fingerprints, tasks and verification stay per instance. Pure.
import type { AuditFinding, Certainty, FindingKind, RuleCategory, Severity } from "./types";

export interface Groupable {
  fingerprint: string;
  siteId: string;
  finding: AuditFinding;
  task?: { workflowStatus: string } | null;
}

export interface IssueGroup<T extends Groupable = Groupable> {
  key: string;
  siteId: string;
  ruleCode: string;
  title: string;
  category: RuleCategory;
  kind: FindingKind;
  certainty: Certainty;
  /** Of the most urgent instance. */
  severity: Severity;
  /** Best (lowest) priority level among the instances. */
  priority: number;
  instances: T[];
  /** Distinct page URLs across the instances, sorted. */
  pages: string[];
  /** Instances with a task that is still being worked on. */
  withActiveTask: number;
}

const CLOSED = new Set(["resolved", "wont_fix"]);

export function groupIssues<T extends Groupable>(rows: T[]): IssueGroup<T>[] {
  const groups = new Map<string, IssueGroup<T>>();
  for (const r of rows) {
    const key = `${r.siteId}\u0000${r.finding.ruleCode}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        siteId: r.siteId,
        ruleCode: r.finding.ruleCode,
        title: r.finding.title,
        category: r.finding.category,
        kind: r.finding.kind,
        certainty: r.finding.certainty,
        severity: r.finding.priority.severity,
        priority: r.finding.priority.level,
        instances: [],
        pages: [],
        withActiveTask: 0,
      };
      groups.set(key, g);
    }
    g.instances.push(r);
    if (r.finding.priority.level < g.priority) {
      g.priority = r.finding.priority.level;
      g.severity = r.finding.priority.severity;
      g.title = r.finding.title;
    }
    if (r.task && !CLOSED.has(r.task.workflowStatus)) g.withActiveTask++;
  }
  for (const g of groups.values()) {
    g.pages = [...new Set(g.instances.map((i) => i.finding.pageUrl))].sort();
    g.instances.sort((a, b) => a.finding.priority.level - b.finding.priority.level || a.finding.pageUrl.localeCompare(b.finding.pageUrl));
  }
  return [...groups.values()].sort((a, b) => a.priority - b.priority || b.instances.length - a.instances.length || a.title.localeCompare(b.title));
}
