// CSV export of the URL explorer, built in the browser: RFC 4180 quoting, CRLF rows, a UTF-8 BOM so Excel reads
// non-ASCII titles, and a leading apostrophe on text that a spreadsheet would run as a formula (CSV injection).
import type { UrlRow } from "@/lib/results/explore";
import { COLUMN_IDS, COLUMN_LABEL, exportValue, type ColumnId } from "./columns";

/** Text starting with one of these is a formula in Excel, LibreOffice and Sheets (tab and CR per OWASP). */
const FORMULA_START = /^[=+\-@\t\r]/;

/** One cell: null as empty, text guarded against formulas, then quoted when it holds a quote, comma or line break. */
export function csvCell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && FORMULA_START.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A whole document: BOM, header row, data rows, CRLF line endings (RFC 4180). */
export function toCsv(header: string[], rows: (string | number | boolean | null)[][]): string {
  return "﻿" + [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** Every field of every given row (not only the visible columns), URL first. */
export function urlRowsCsv(rows: UrlRow[]): string {
  const cols: (ColumnId | "url")[] = ["url", ...COLUMN_IDS];
  return toCsv(
    cols.map((c) => COLUMN_LABEL[c]),
    rows.map((r) => cols.map((c) => exportValue(r, c))),
  );
}
