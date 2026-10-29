import { getGroupUrlsCsv } from "@/lib/server/report";
import { route } from "../../../../../../_lib/handler";

/** Every URL one issue group affects, with its state, as CSV. */
export const GET = route<{ ws: string; id: string; rule: string }>(async (_req, { ws, id, rule }) => {
  const csv = await getGroupUrlsCsv(ws, id, rule);
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${rule.replace(/[^\w-]/g, "_")}-urls.csv"`, "cache-control": "private, no-store" } });
});
