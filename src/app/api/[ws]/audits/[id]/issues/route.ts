import { getAuditIssues } from "@/lib/server/results";
import { route } from "../../../../_lib/handler";

/** Every fingerprint of a v2 audit with its effective state (verified fixes applied): the Issues explorer's rows. */
export const GET = route<{ ws: string; id: string }>(async (_req, { ws, id }) => getAuditIssues(ws, id));
