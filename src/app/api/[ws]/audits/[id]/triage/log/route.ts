import { getTriageLog } from "@/lib/server/results";
import { route } from "../../../../../_lib/handler";

/** Who changed what in triage, newest first; `?subject=` narrows to one issue group or issue. */
export const GET = route<{ ws: string; id: string }>(async (req, { ws, id }) => getTriageLog(ws, id, req.nextUrl.searchParams.get("subject") ?? undefined));
