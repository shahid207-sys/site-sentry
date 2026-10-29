import { getAuditOverview } from "@/lib/server/results";
import { route } from "../../../../_lib/handler";

/** Coverage, health score, issue states and priorities of a v2 audit: the query its report uses. */
export const GET = route<{ ws: string; id: string }>(async (_req, { ws, id }) => getAuditOverview(ws, id));
