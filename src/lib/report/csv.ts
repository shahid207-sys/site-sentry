// A group's full affected-URL list as CSV (the report's appendix links it for lists over INLINE_URLS rows).
import type { Db } from "../db/client";
import { affectedUrlList } from "../results/queries";

type Exec = Pick<Db, "execute">;

/** RFC 4180 quoting; a cell a spreadsheet would run as a formula is prefixed with '. */
export const csvCell = (v: string) => {
  const s = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function groupUrlsCsv(db: Exec, crawlId: string, ruleId: string): Promise<string> {
  const rows = await affectedUrlList(db, crawlId, ruleId);
  return ["url,state", ...rows.map((r) => `${csvCell(r.url)},${csvCell(r.state)}`)].join("\r\n") + "\r\n";
}
