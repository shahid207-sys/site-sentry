// Pure logic of the Compare screen (no React): which audits can be a comparison base, the change filter and sort
// keys of the groups table, where each group links in the Issues explorer, and the before / after figures of the two
// audits' overviews. Every number comes from the /compare/groups response.
import type { IssueState } from "@/lib/db/schema";
import type { CrawlOverview, GroupChange, GroupComparison } from "@/lib/results/queries";
import type { AuditSummary } from "@/lib/views";
import { OPEN_STATES } from "../issues/filter";
import { CHANGE_ORDER } from "../overview/model";

export { CHANGE_ORDER };

export const parseChange = (v: string | null): GroupChange | null => (CHANGE_ORDER.includes(v as GroupChange) ? (v as GroupChange) : null);

/**
 * Audits of the same site that can be the base of a comparison with `currentId`: run on crawler v2, analysed (the
 * server refuses an audit whose analysis has not completed), not still running, and started before the current audit
 * (compareCrawls orders the pair older → newer, so a later audit would silently become the "after" side). Newest first.
 */
export function comparableAudits(audits: AuditSummary[], currentId: string): AuditSummary[] {
  const current = audits.find((a) => a.id === currentId);
  return audits
    .filter((a) => a.id !== currentId && !!a.crawler && a.crawler.analysis === "completed" && a.status !== "running" && (!current || a.startedAt < current.startedAt))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : a.startedAt > b.startedAt ? -1 : 0));
}

/** Fingerprints the group comparison counted (every change, inconclusive included). */
export const totalFingerprints = (g: GroupComparison) => Object.values(g.counts).reduce((n, x) => n + (x ?? 0), 0);

/** Groups with the given change, or all. */
export const filterByChange = (groups: GroupComparison[], change: GroupChange | null) => (change ? groups.filter((g) => g.change === change) : groups);

/** Default order: what got worse first (CHANGE_ORDER), then most fingerprints, then rule id. */
export function defaultOrder(groups: GroupComparison[]): GroupComparison[] {
  return [...groups].sort(
    (a, b) => CHANGE_ORDER.indexOf(a.change) - CHANGE_ORDER.indexOf(b.change) || totalFingerprints(b) - totalFingerprints(a) || (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0),
  );
}

export const COUNT_COLUMNS = ["new", "regressed", "persistent", "not_rechecked", "resolved", "inconclusive"] as const;

/** Sort key of a groups-table column (see VirtualTable sortRows). */
export function compareSortKey(g: GroupComparison, id: string, title: (ruleId: string) => string): string | number | null {
  if (id === "change") return CHANGE_ORDER.indexOf(g.change);
  if (id === "rule") return title(g.ruleId).toLowerCase();
  if (id === "total") return totalFingerprints(g);
  if ((COUNT_COLUMNS as readonly string[]).includes(id)) return g.counts[id as (typeof COUNT_COLUMNS)[number]] ?? 0;
  return null;
}

/**
 * The group in this (the later) audit's Issues explorer. A resolved group has no open issue group, so the grouped view
 * would be empty: resolved and not-re-checked groups open the flat list of that rule's findings in that state.
 */
export function issuesHref(auditBase: string, g: Pick<GroupComparison, "ruleId" | "change">): string {
  const r = encodeURIComponent(g.ruleId);
  if (g.change === "resolved" || g.change === "not_rechecked") return `${auditBase}/issues?view=flat&rule=${r}&state=${g.change}`;
  return `${auditBase}/issues?rule=${r}&expand=${r}`;
}

/** Open findings of an audit: new, persistent, regressed and not re-checked. */
export const openFindings = (states: Partial<Record<IssueState, number>>) => OPEN_STATES.reduce((n, s) => n + (states[s] ?? 0), 0);

export interface BeforeAfter {
  id: "health" | "open" | "groups" | "coverage" | "resolved";
  label: string;
  before: number | null;
  after: number | null;
  /** after − before, rounded to one decimal; null when either side is unknown. */
  delta: number | null;
  /** Whether a higher number is better (for wording the delta). */
  higherIsBetter: boolean;
  unit?: "%";
}

const diff = (a: number | null, b: number | null) => (a === null || b === null ? null : Math.round((b - a) * 10) / 10);

export function beforeAfter(base: CrawlOverview, head: CrawlOverview): BeforeAfter[] {
  const rows: Omit<BeforeAfter, "delta">[] = [
    { id: "health", label: "Health score", before: base.health?.score ?? null, after: head.health?.score ?? null, higherIsBetter: true },
    { id: "open", label: "Open findings", before: openFindings(base.states), after: openFindings(head.states), higherIsBetter: false },
    { id: "groups", label: "Issue groups", before: base.issueGroups, after: head.issueGroups, higherIsBetter: false },
    { id: "resolved", label: "Resolved findings", before: base.states.resolved ?? 0, after: head.states.resolved ?? 0, higherIsBetter: true },
    { id: "coverage", label: "Coverage", before: base.coverage.percent, after: head.coverage.percent, higherIsBetter: true, unit: "%" },
  ];
  return rows.map((r) => ({ ...r, delta: diff(r.before, r.after) }));
}

/** "better", "worse" or "same" for a before / after row; null when unknown. */
export function trend(r: Pick<BeforeAfter, "delta" | "higherIsBetter">): "better" | "worse" | "same" | null {
  if (r.delta === null) return null;
  if (r.delta === 0) return "same";
  return r.delta > 0 === r.higherIsBetter ? "better" : "worse";
}
