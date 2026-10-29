import { getAuditGroups } from "@/lib/server/results";
import { route } from "../../../../_lib/handler";

/** Issue groups of a v2 audit with priority inputs, template split and states: the query its report uses. */
export const GET = route<{ ws: string; id: string }>(async (_req, { ws, id }) => getAuditGroups(ws, id));
