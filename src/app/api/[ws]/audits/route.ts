import { listAudits, summarize } from "@/lib/server/queries";
import { assertLiveScans, getStore } from "@/lib/workspace";
import { AuditRequest, launchAudit } from "../../_lib/audits";
import { body, rateLimit, route } from "../../_lib/handler";

export const GET = route<{ ws: string }>(async (req, { ws }) => listAudits(ws, req.nextUrl.searchParams.get("site") ?? undefined));

export const POST = route<{ ws: string }>(async (req, { ws }) => {
  rateLimit(req, `audit:${ws}`, 10, 60_000);
  assertLiveScans(ws);
  const { audit, reused } = await launchAudit(ws, await body(req, AuditRequest));
  return { audit: summarize(audit, await getStore(ws).read()), reused };
});
