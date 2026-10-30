import { getAuditUrls } from "@/lib/server/results";
import { route } from "../../../../_lib/handler";

/** Every URL of a v2 audit with its state, status, page facts and open issue count: the URL explorer's rows. */
export const GET = route<{ ws: string; id: string }>(async (_req, { ws, id }) => getAuditUrls(ws, id));
