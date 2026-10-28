import { clearAuditHistory } from "@/lib/workflow/audits";
import { getDeps } from "@/lib/workspace";
import { route } from "../../../../_lib/handler";

/** Clears the site's audit history (audits and their tasks); the site and its settings stay. */
export const DELETE = route<{ ws: string; id: string }>(async (_req, { ws, id }) => clearAuditHistory(id, await getDeps(ws)));
