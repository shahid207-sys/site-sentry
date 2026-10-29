import { getAuditReport } from "@/lib/server/report";
import { route } from "../../../../_lib/handler";

/** The report's data (every number the HTML report and PDF print), as JSON. */
export const GET = route<{ ws: string; id: string }>(async (_req, { ws, id }) => getAuditReport(ws, id));
