// Columns of the URL explorer (SPEC screen 6) as plain data: ids, labels, presets, the query-string form of the
// visible set, sort keys and CSV values. Only fields UrlRow really has; the spec's "40+ columns" need more data
// from the server first (see the Phase 4 report).
import type { UrlRow } from "@/lib/results/explore";
import { READ_STATES } from "./filter";

/** Every toggleable column, in display order. The URL column is always shown and is not listed. */
export const COLUMN_IDS = [
  "state",
  "status",
  "noindex",
  "canonical",
  "redirectTarget",
  "depth",
  "reason",
  "title",
  "h1",
  "description",
  "wordCount",
  "templateId",
  "inbound",
  "linkDepth",
  "pagerank",
  "discoveredVia",
  "elapsedMs",
  "bytes",
  "contentType",
  "openIssues",
] as const;
export type ColumnId = (typeof COLUMN_IDS)[number];

export const COLUMN_LABEL: Record<ColumnId | "url", string> = {
  url: "URL",
  state: "State",
  status: "Status",
  noindex: "noindex",
  canonical: "Canonical",
  redirectTarget: "Redirect target",
  depth: "Depth",
  reason: "Reason",
  title: "Title",
  h1: "H1",
  description: "Description",
  wordCount: "Words",
  templateId: "Template",
  inbound: "Inbound links",
  linkDepth: "Link depth",
  pagerank: "PageRank",
  discoveredVia: "Discovered via",
  elapsedMs: "Fetch ms",
  bytes: "Bytes",
  contentType: "Content type",
  openIssues: "Open issues",
};

export const PRESETS = {
  indexability: { label: "Indexability", cols: ["state", "status", "noindex", "canonical", "redirectTarget", "depth", "reason", "openIssues"] },
  content: { label: "Content", cols: ["title", "h1", "description", "wordCount", "templateId", "openIssues"] },
  links: { label: "Links", cols: ["inbound", "linkDepth", "pagerank", "discoveredVia", "depth", "openIssues"] },
  performance: { label: "Performance", cols: ["status", "elapsedMs", "bytes", "contentType", "openIssues"] },
} as const satisfies Record<string, { label: string; cols: readonly ColumnId[] }>;
export type PresetId = keyof typeof PRESETS;
export const PRESET_IDS = Object.keys(PRESETS) as PresetId[];

/** Shown when the query string names no columns. */
export const DEFAULT_COLS: ColumnId[] = ["state", "status", "title", "wordCount", "inbound", "openIssues"];

const known = new Set<string>(COLUMN_IDS);
const order = (cols: Iterable<ColumnId>) => {
  const set = new Set(cols);
  return COLUMN_IDS.filter((c) => set.has(c));
};

/** The visible columns from `cols=` (comma list); unknown ids are dropped, an empty or missing value is the default. */
export function parseCols(v: string | null): ColumnId[] {
  if (!v) return DEFAULT_COLS;
  const cols = order(v.split(",").filter((c): c is ColumnId => known.has(c)));
  return cols.length ? cols : DEFAULT_COLS;
}

/** The `cols=` value for a set; null for the default set, so the default view keeps a clean URL. */
export function formatCols(cols: Iterable<ColumnId>): string | null {
  const list = order(cols);
  if (!list.length || sameSet(list, DEFAULT_COLS)) return null;
  return list.join(",");
}

function sameSet(a: readonly ColumnId[], b: readonly ColumnId[]): boolean {
  const x = order(a);
  const y = order(b);
  return x.length === y.length && x.every((c, i) => c === y[i]);
}

/** The preset the visible set equals, if any. */
export const presetOf = (cols: readonly ColumnId[]): PresetId | null => PRESET_IDS.find((p) => sameSet(cols, PRESETS[p].cols)) ?? null;

/** Sort key of a column ("url" included); nulls sort last (sortRows). */
export function sortKey(r: UrlRow, id: string): string | number | null {
  switch (id) {
    case "url":
      return r.url;
    case "noindex":
      // Unknown (not read) sorts with the nulls, not next to a real "no".
      return READ_STATES.has(r.state) ? (r.noindex ? 1 : 0) : null;
    case "discoveredVia":
      return r.discoveredVia.length ? r.discoveredVia.join(",") : null;
    default: {
      if (!known.has(id)) return null;
      const v = r[id as Exclude<ColumnId, "noindex" | "discoveredVia">];
      return typeof v === "string" ? v.toLowerCase() : (v ?? null);
    }
  }
}

/** A column's value as exported (CSV): raw numbers, lists joined with "; ", noindex as yes / no (empty when unknown). */
export function exportValue(r: UrlRow, id: ColumnId | "url"): string | number | null {
  switch (id) {
    case "noindex":
      return READ_STATES.has(r.state) ? (r.noindex ? "yes" : "no") : null;
    case "discoveredVia":
      return r.discoveredVia.join("; ");
    default:
      return r[id] ?? null;
  }
}
