import { getAuditIssues } from "@/lib/server/results";
import { route } from "../../../../_lib/handler";

/** Every fingerprint of a v2 audit with its effective state (verified fixes applied); `?rule=` narrows to one rule, with messages. */
export const GET = route<{ ws: string; id: string }>(async (req, { ws, id }) => getAuditIssues(ws, id, req.nextUrl.searchParams.get("rule") ?? undefined));
