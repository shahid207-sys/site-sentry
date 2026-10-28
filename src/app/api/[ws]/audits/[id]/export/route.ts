import { auditToJson, exportName, findingsToCsv } from "@/lib/export";
import { applyFilter, parseFilter, type FindingSort } from "@/lib/filters";
import { getAuditDetail } from "@/lib/server/queries";
import { HttpError, route } from "../../../../_lib/handler";

/** CSV or JSON of the audit's findings, filtered exactly like the results table (same query parameters). */
export const GET = route<{ ws: string; id: string }>(async (req, { ws, id }) => {
  const sp = req.nextUrl.searchParams;
  const format = sp.get("format") ?? "csv";
  if (format !== "csv" && format !== "json") throw new HttpError(400, "INVALID", "format must be csv or json.");
  const detail = await getAuditDetail(ws, id);
  if (detail.audit.status === "running") throw new HttpError(409, "CONFLICT", "The audit is still running. Export it when it has finished.");
  const filter = parseFilter(sp);
  const findings = applyFilter(detail.findings, filter, detail.changes, (sp.get("sort") as FindingSort | null) ?? "priority");
  const name = exportName(detail.site.name, detail.audit.startedAt, `${ws === "sample" ? "sample-" : ""}findings.${format}`);
  const text = format === "csv" ? findingsToCsv(findings, detail.changes) : auditToJson(detail, findings, { ...filter });
  return new Response(text, {
    headers: {
      "content-type": format === "csv" ? "text/csv; charset=utf-8" : "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${name}"`,
      "cache-control": "no-store",
    },
  });
});
