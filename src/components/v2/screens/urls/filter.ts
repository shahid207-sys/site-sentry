// Filters of the URL explorer, all read from the query string: text or regex on the URL, state, status class,
// noindex, open issues and template. Pure, so 14k rows filter in one pass on every keystroke.
import type { UrlRow } from "@/lib/results/explore";

export const STATUS_CLASSES = ["2xx", "3xx", "4xx", "5xx", "none"] as const;
export type StatusClass = (typeof STATUS_CLASSES)[number];

export const STATUS_CLASS_LABEL: Record<StatusClass, string> = {
  "2xx": "2xx success",
  "3xx": "3xx redirect",
  "4xx": "4xx client error",
  "5xx": "5xx server error",
  none: "No response",
};

/** The class of an HTTP status; "none" when no response was received; null for anything outside 2xx–5xx. */
export function statusClass(status: number | null): StatusClass | null {
  if (status === null) return "none";
  const c = Math.floor(status / 100);
  return c >= 2 && c <= 5 ? (`${c}xx` as StatusClass) : null;
}

/** Longest regex accepted after "re:" (keeps a pasted blob from compiling into something huge). */
export const REGEX_MAX = 200;

export type UrlMatcher = { test: ((url: string) => boolean) | null; error: string | null };

/**
 * The URL filter: case-insensitive text, or a case-insensitive regular expression after "re:". An invalid or
 * over-long pattern reports an error and filters nothing, so a typo never shows an empty table.
 */
export function parseUrlFilter(q: string): UrlMatcher {
  const text = q.trim();
  if (!text) return { test: null, error: null };
  if (/^re:/i.test(text)) {
    const pattern = text.slice(3);
    if (!pattern) return { test: null, error: null };
    if (pattern.length > REGEX_MAX) return { test: null, error: `Regular expressions are limited to ${REGEX_MAX} characters.` };
    try {
      const re = new RegExp(pattern, "i");
      return { test: (u) => re.test(u), error: null };
    } catch (e) {
      return { test: null, error: `Invalid regular expression: ${(e as Error).message}` };
    }
  }
  const needle = text.toLowerCase();
  return { test: (u) => u.toLowerCase().includes(needle), error: null };
}

export type YesNo = "yes" | "no";
export const yesNo = (v: string | null): YesNo | null => (v === "yes" || v === "no" ? v : null);

export interface UrlFilters {
  match: UrlMatcher["test"];
  state: string | null;
  status: StatusClass | null;
  noindex: YesNo | null;
  issues: YesNo | null;
  template: string | null;
}

/** States whose URL got an HTML response the crawler read, so noindex is known (it is false otherwise). */
export const READ_STATES = new Set(["fetched", "analysed"]);

/** Whether a row passes every filter; `skip` leaves one filter out (for the per-state chip counts). */
export function passes(r: UrlRow, f: UrlFilters, skip?: "state"): boolean {
  if (f.match && !f.match(r.url)) return false;
  if (skip !== "state" && f.state && r.state !== f.state) return false;
  if (f.status && statusClass(r.status) !== f.status) return false;
  if (f.noindex === "yes" && !r.noindex) return false;
  // "No noindex" means read and not noindex: an unfetched URL's noindex is unknown, not "no".
  if (f.noindex === "no" && (r.noindex || !READ_STATES.has(r.state))) return false;
  if (f.issues === "yes" && r.openIssues === 0) return false;
  if (f.issues === "no" && r.openIssues > 0) return false;
  if (f.template && r.templateId !== f.template) return false;
  return true;
}

/** Rows passing every filter, plus the count per state with every filter but the state one (the quick chips). */
export function applyFilters(rows: UrlRow[], f: UrlFilters): { rows: UrlRow[]; stateCounts: [string, number][] } {
  const out: UrlRow[] = [];
  const counts = new Map<string, number>();
  for (const r of rows) {
    if (!passes(r, f, "state")) continue;
    counts.set(r.state, (counts.get(r.state) ?? 0) + 1);
    if (!f.state || r.state === f.state) out.push(r);
  }
  // A selected state stays as a chip even when the other filters leave none of it.
  if (f.state && !counts.has(f.state)) counts.set(f.state, 0);
  return { rows: out, stateCounts: [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
}

/** Distinct templates with their URL counts, most URLs first. */
export function templateCounts(rows: UrlRow[]): [string, number][] {
  const m = new Map<string, number>();
  for (const r of rows) if (r.templateId) m.set(r.templateId, (m.get(r.templateId) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}
