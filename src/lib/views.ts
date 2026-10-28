// View models returned by the API and rendered by the UI. Types only (plus tiny pure helpers):
// safe to import from client components.
import type { ChangeKind, Comparison } from "./audit/compare";
import type { IssueOccurrence, IssueState } from "./audit/issues";
import type { AuditFinding, Certainty, FindingKind, RuleCategory, Severity } from "./audit/types";
import type { AuditRun, FixTask, PageIntent, PageSnapshot, SampleState, Site, Workspace, WorkspaceSettings } from "./model";
import type { CheckInfo } from "./audit/catalog";

export type SeverityCounts = Record<Severity, number>;

/** Audit metadata without crawl internals (queue, seen, link queue). */
export type AuditSummary = Omit<AuditRun, "queue" | "seen" | "linkQueue" | "linkChecks" | "robots" | "sitemap"> & {
  siteName: string;
  stale: boolean;
};

export interface SiteRow {
  site: Site;
  importantUrls: number;
  lastAudit: AuditSummary | null;
  runningAudit: AuditSummary | null;
  open: SeverityCounts;
  openTotal: number;
  /** Distinct open checks by worst severity: the unit the health score counts. */
  openTypes: SeverityCounts;
  /** See lib/audit/health.ts. Null until the site has a finished audit. */
  health: number | null;
  activeTasks: number;
}

export interface ActionItem {
  kind: "verify" | "fix" | "resume" | "configure";
  title: string;
  detail: string;
  href: string;
  severity?: Severity;
  siteName: string;
  priority?: number;
}

/** Open issue instances of one check on one site. */
export interface IssueGroupRow {
  siteId: string;
  siteName: string;
  ruleCode: string;
  title: string;
  category: RuleCategory;
  kind: FindingKind;
  certainty: Certainty;
  severity: Severity;
  priority: number;
  instances: number;
  pages: number;
  /** Up to five affected URLs, for a preview. */
  samplePages: string[];
  withActiveTask: number;
  /** Set when the group is a single instance, so the row can link straight to it. */
  fingerprint: string | null;
}

export interface SinceLast {
  /** Detected where the previous audit ran the same check on the same scope and did not find it. */
  regression: number;
  /** Detected for the first time because the previous audit did not check this scope. Not a change. */
  firstDetected: number;
  resolved: number;
  notRechecked: number;
  comparedSites: number;
  /** Sites whose previous audit checked fewer pages or categories than the latest one. */
  narrowerBaselineSites: string[];
}

export interface OverviewData {
  workspace: Workspace;
  sites: SiteRow[];
  totals: {
    sites: number;
    auditsFinished: number;
    open: SeverityCounts;
    /** Open issue instances (one per check per page). */
    openTotal: number;
    /** Distinct (site, check) groups among the open instances. */
    openGroups: number;
    /** Pages inspected by each site's latest finished audit, summed. */
    pagesInspected: number;
    /** From each site's latest audit compared with its previous one. Null when no site has two audits. */
    sinceLast: SinceLast | null;
    resolvedTotal: number;
    /** Tasks whose latest re-fetch passed every acceptance criterion. */
    verifiedTasks: number;
    tasksActive: number;
    tasksReady: number;
  };
  /** Open issues grouped by site and check, most urgent first. */
  groups: IssueGroupRow[];
  actions: ActionItem[];
  recentAudits: AuditSummary[];
}

export interface IssueRow {
  fingerprint: string;
  siteId: string;
  siteName: string;
  state: IssueState;
  stale: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  lastSeenAuditId: string;
  resolvedAt: string | null;
  regressedAt: string | null;
  finding: AuditFinding;
  task: { id: string; title: string; workflowStatus: FixTask["workflowStatus"]; verificationStatus: FixTask["verificationStatus"] } | null;
}

export interface IssueDetail extends IssueRow {
  history: IssueOccurrence[];
  related: IssueRow[];
  snapshot: SlimSnapshot | null;
  tasks: { id: string; title: string; workflowStatus: FixTask["workflowStatus"]; verificationStatus: FixTask["verificationStatus"]; verifications: FixTask["verifications"] }[];
}

export type SlimSnapshot = Omit<PageSnapshot, "rules" | "links"> & {
  ruleStatus: { ruleId: string; name: string; status: string; missingExpectations: string[] }[];
  outLinks: number | null;
};

export interface AuditDetail {
  audit: AuditSummary;
  site: Site;
  configLines: string[];
  pages: SlimSnapshot[];
  findings: AuditFinding[];
  robots: AuditRun["robots"];
  sitemap: Omit<NonNullable<AuditRun["sitemap"]>, "urls"> | null;
  linkChecks: AuditRun["linkChecks"][string][];
  previous: AuditSummary | null;
  /** Change kind of each finding in this audit relative to the previous audit. */
  changes: Record<string, ChangeKind> | null;
  /** Findings of the previous audit that this audit no longer reports. */
  gone: { resolved: number; notRechecked: number } | null;
  tasksByFingerprint: Record<string, { id: string; title: string; workflowStatus: FixTask["workflowStatus"] }>;
}

export interface ComparisonData {
  base: AuditSummary;
  head: AuditSummary;
  site: Site;
  comparison: Comparison;
  candidates: AuditSummary[];
}

export interface SiteDetail {
  site: Site;
  pages: PageIntent[];
  audits: AuditSummary[];
  open: SeverityCounts;
  openTotal: number;
  resolvedTotal: number;
  tasks: { active: number; ready: number };
  topIssues: IssueRow[];
}

export type TaskRow = FixTask & { siteName: string; siteOrigin: string };

export interface SettingsData {
  workspace: Workspace;
  settings: WorkspaceSettings;
  checks: CheckInfo[];
  sampleState: SampleState | null;
  storage: { persistent: boolean; ephemeral: boolean };
  liveScans: { enabled: boolean; allowedHosts: string[] | null };
}

export const SEVERITIES: Severity[] = ["high", "medium", "low"];
export const emptyCounts = (): SeverityCounts => ({ high: 0, medium: 0, low: 0 });

export const CHANGE_LABELS: Record<ChangeKind, string> = {
  regression: "Regression",
  new: "New",
  changed: "Changed",
  persistent: "Persistent",
  resolved: "Resolved",
  not_rechecked: "Not re-checked",
};
