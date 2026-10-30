// Pure logic of the Issues explorer (no React, no DOM): text / regex matching, the flat view's filters over up to
// ~50k fingerprints, the grouped view's group filter, sort keys, and the triage markers and batches. Kept here so the
// Phase 4 gate (50,000-finding filter under 200 ms) is testable without a browser.
import type { IssueState } from "@/lib/db/schema";
import type { IssueGroupRow } from "@/lib/results/queries";
import type { IssueRow } from "@/lib/results/explore";
import type { Priority } from "@/lib/results/priority";
import type { TriageEntry } from "@/lib/results/triage";

/** Copy of OPEN_STATES in src/lib/results/states.ts (that module imports drizzle, so the browser cannot load it). */
export const OPEN_STATES: IssueState[] = ["new", "persistent", "regressed", "not_rechecked"];
/** Display order of issue states (badges.tsx ISSUE_STATES, repeated here so this module stays free of React). */
const STATE_ORDER: IssueState[] = ["new", "regressed", "persistent", "not_rechecked", "inconclusive", "resolved"];
const PRIORITY_ORDER: Priority[] = ["critical", "high", "medium", "low", "info"];

/** Longest pattern accepted after "re:" (a guard against pathological regexes typed into a 50k-row filter). */
export const REGEX_MAX = 200;

export interface TextMatcher {
  /** False when the box is empty, or the regex is invalid (then the filter is ignored and `error` says why). */
  active: boolean;
  regex: RegExp | null;
  /** Lower-cased needle for a plain substring search. */
  needle: string;
  error: string | null;
}

/** The text filter: a case-insensitive substring, or a regex after a "re:" prefix (capped, never throws). */
export function textMatcher(raw: string): TextMatcher {
  const t = raw.trim();
  if (!t) return { active: false, regex: null, needle: "", error: null };
  if (!t.toLowerCase().startsWith("re:")) return { active: true, regex: null, needle: t.toLowerCase(), error: null };
  const pattern = t.slice(3);
  if (!pattern) return { active: false, regex: null, needle: "", error: null };
  if (pattern.length > REGEX_MAX) return { active: false, regex: null, needle: "", error: `The regex is longer than ${REGEX_MAX} characters, so it is ignored.` };
  try {
    return { active: true, regex: new RegExp(pattern, "i"), needle: "", error: null };
  } catch (e) {
    return { active: false, regex: null, needle: "", error: `Not a valid regex, so it is ignored: ${(e as Error).message}` };
  }
}

/** What a text filter searches per row, built once per data load (not per keystroke). */
export interface RowIndex {
  raw: string[];
  lower: string[];
}

export function indexRows(rows: Pick<IssueRow, "url" | "ruleId">[]): RowIndex {
  const raw = new Array<string>(rows.length);
  const lower = new Array<string>(rows.length);
  for (let i = 0; i < rows.length; i++) {
    raw[i] = `${rows[i].url}\n${rows[i].ruleId}`;
    lower[i] = raw[i].toLowerCase();
  }
  return { raw, lower };
}

/** Priority and category of a rule in this audit: from its issue group, else (no open group) the catalog's category. */
export interface RuleFacts {
  priority: Priority | null;
  category: string | null;
}

export function ruleFacts(groups: Pick<IssueGroupRow, "ruleId" | "priority" | "category">[], catalog?: Map<string, { category: string }> | null): Map<string, RuleFacts> {
  const m = new Map<string, RuleFacts>();
  if (catalog) for (const [id, r] of catalog) m.set(id, { priority: null, category: r.category });
  for (const g of groups) m.set(g.ruleId, { priority: g.priority, category: g.category });
  return m;
}

export interface IssueFilters {
  text: string;
  /** "open" or one IssueState. */
  state: string | null;
  /** A Priority, or "none" for rules with no issue group in this audit. */
  priority: string | null;
  category: string | null;
  /** A template id, or "none" for URLs without one. */
  template: string | null;
  rule: string | null;
}

export const NO_FILTERS: IssueFilters = { text: "", state: null, priority: null, category: null, template: null, rule: null };

export const hasFilters = (f: IssueFilters) => !!(f.text.trim() || f.state || f.priority || f.category || f.template || f.rule);

const stateMatches = (state: IssueState, want: string) => (want === "open" ? OPEN_STATES.includes(state) : state === want);

/** The flat view's filter. `index` must come from indexRows(rows). */
export function filterIssues(rows: IssueRow[], index: RowIndex, f: IssueFilters, facts: Map<string, RuleFacts>): IssueRow[] {
  const m = textMatcher(f.text);
  if (!m.active && !f.state && !f.priority && !f.category && !f.template && !f.rule) return rows;
  const out: IssueRow[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (f.rule && r.ruleId !== f.rule) continue;
    if (f.state && !stateMatches(r.state, f.state)) continue;
    if (f.template && (f.template === "none" ? r.templateId !== null : r.templateId !== f.template)) continue;
    if (f.priority || f.category) {
      const x = facts.get(r.ruleId);
      if (f.priority && (x?.priority ?? "none") !== f.priority) continue;
      if (f.category && x?.category !== f.category) continue;
    }
    if (m.active && !(m.regex ? m.regex.test(r.url) || m.regex.test(r.ruleId) : index.lower[i].includes(m.needle))) continue;
    out.push(r);
  }
  return out;
}

/** The grouped view's filter: text over rule id and title, state (any fingerprint in it), priority, category, template. */
export function filterGroups(groups: IssueGroupRow[], f: IssueFilters, title: (ruleId: string) => string): IssueGroupRow[] {
  const m = textMatcher(f.text);
  return groups.filter((g) => {
    if (f.rule && g.ruleId !== f.rule) return false;
    if (f.priority && g.priority !== f.priority) return false;
    if (f.category && g.category !== f.category) return false;
    if (f.state && !Object.entries(g.states).some(([s, n]) => (n ?? 0) > 0 && stateMatches(s as IssueState, f.state!))) return false;
    if (f.template && f.template !== "none" && !g.templates.some((t) => t.templateId === f.template)) return false;
    if (m.active) {
      const t = title(g.ruleId);
      if (!(m.regex ? m.regex.test(g.ruleId) || m.regex.test(t) : `${g.ruleId}\n${t}`.toLowerCase().includes(m.needle))) return false;
    }
    return true;
  });
}

export const priorityRank = (p: Priority | null | undefined) => (p ? PRIORITY_ORDER.indexOf(p) : PRIORITY_ORDER.length);
const stateRank = (s: IssueState) => STATE_ORDER.indexOf(s);

/** Sort key of a flat row per column id (see sortRows in VirtualTable.tsx). */
export function issueSortKey(row: IssueRow, id: string, facts: Map<string, RuleFacts>): string | number | null {
  switch (id) {
    case "priority":
      return priorityRank(facts.get(row.ruleId)?.priority);
    case "rule":
      return row.ruleId;
    case "url":
      return row.url;
    case "state":
      return stateRank(row.state);
    case "template":
      return row.templateId;
    default:
      return null;
  }
}

/** Templates present in the rows, most URLs first. */
export function templateOptions(rows: Pick<IssueRow, "templateId">[]): { id: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.templateId) counts.set(r.templateId, (counts.get(r.templateId) ?? 0) + 1);
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
}

/** Templates of the groups (grouped view), most affected URLs first. */
export function groupTemplateOptions(groups: Pick<IssueGroupRow, "templates">[]): { id: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const g of groups) for (const t of g.templates) counts.set(t.templateId, (counts.get(t.templateId) ?? 0) + t.affectedUrls);
  return [...counts].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count || (a.id < b.id ? -1 : 1));
}

/** A group's fingerprint counts in display order, zeros dropped. */
export function stateSummary(states: Partial<Record<IssueState, number>>): { state: IssueState; n: number }[] {
  return STATE_ORDER.flatMap((s) => ((states[s] ?? 0) > 0 ? [{ state: s, n: states[s]! }] : []));
}

// ---------- drawer subject ----------

export type Subject = { kind: "rule"; id: string } | { kind: "fp"; id: string };

/** "rule:<id>" or "fp:<fingerprint>" (the query string's `open`, and triage's subject format). */
export function parseSubject(v: string | null): Subject | null {
  if (!v) return null;
  if (v.startsWith("rule:") && v.length > 5) return { kind: "rule", id: v.slice(5) };
  if (v.startsWith("fp:") && v.length > 3) return { kind: "fp", id: v.slice(3) };
  return null;
}

// ---------- triage ----------

export const triageIndex = (entries: TriageEntry[] | undefined) => new Map((entries ?? []).map((e) => [e.subject, e]));

/** What a person decided about one fingerprint, in words; null when nothing (todo). Never an issue state. */
export function rowMarker(e: Pick<TriageEntry, "status" | "note"> | undefined): string | null {
  if (!e) return null;
  if (e.status === "fixed") return "Marked fixed";
  if (e.status === "ignored") return `Ignored: ${e.note ?? "no reason given"}`;
  return null;
}

/** Most subjects one triage request takes (src/app/api/[ws]/audits/[id]/triage/route.ts). */
export const TRIAGE_BATCH = 5000;

export function chunk<T>(xs: T[], n = TRIAGE_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n));
  return out;
}

export interface TriageBatch {
  subjects: string[];
  status: TriageEntry["status"];
  note?: string;
}

/**
 * Assigning keeps each subject's status (a POST always sets one): subjects are batched by their current status and
 * note, so an ignored issue keeps its reason. Fingerprints default to todo, groups to todo.
 */
export function assignBatches(subjects: string[], index: Map<string, Pick<TriageEntry, "status" | "note">>): TriageBatch[] {
  const by = new Map<string, TriageBatch>();
  for (const s of subjects) {
    const e = index.get(s);
    const status = e?.status ?? "todo";
    const note = status === "ignored" ? (e?.note ?? undefined) : undefined;
    const key = `${status}\u0000${note ?? ""}`;
    const b = by.get(key) ?? { subjects: [], status, note };
    b.subjects.push(s);
    by.set(key, b);
  }
  return [...by.values()].flatMap((b) => chunk(b.subjects).map((part) => ({ ...b, subjects: part })));
}
