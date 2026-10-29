import { getAuditReportHtml, REPORT_HEADERS } from "@/lib/server/report";
import { route } from "../../../../../_lib/handler";

/** The report as one self-contained HTML page. */
export const GET = route<{ ws: string; id: string }>(async (_req, { ws, id }) => {
  const html = await getAuditReportHtml(ws, id, (rule) => `/api/${ws}/audits/${encodeURIComponent(id)}/groups/${encodeURIComponent(rule)}/csv`);
  return new Response(html, { headers: { ...REPORT_HEADERS, "content-type": "text/html; charset=utf-8" } });
});
