import { renderPdf } from "@/lib/report/pdf";
import { getAuditReport } from "@/lib/server/report";
import { renderReport } from "@/lib/report/html";
import { rateLimit, route } from "../../../../../_lib/handler";

/** The report printed to PDF by Chromium: one browser per request, so it is rate-limited. */
export const GET = route<{ ws: string; id: string }>(async (req, { ws, id }) => {
  rateLimit(req, "report-pdf", 6, 60_000);
  const data = await getAuditReport(ws, id);
  const html = renderReport(data, { csvHref: (rule) => `/api/${ws}/audits/${encodeURIComponent(id)}/groups/${encodeURIComponent(rule)}/csv` });
  const { pdf } = await renderPdf(html, data.branding.agencyName ?? new URL(data.overview.siteOrigin).host);
  const name = `seo-audit-${new URL(data.overview.siteOrigin).host}-${data.overview.createdAt.slice(0, 10)}.pdf`.replace(/[^\w.-]/g, "_");
  return new Response(new Uint8Array(pdf), { headers: { "content-type": "application/pdf", "content-disposition": `attachment; filename="${name}"`, "cache-control": "private, no-store", "x-robots-tag": "noindex" } });
});
