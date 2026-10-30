import { clearAuditHistory } from "@/lib/workflow/audits";
import { getDeps } from "@/lib/workspace";
import { syncRunningAudits } from "../../../../_lib/audits";
import { route } from "../../../../_lib/handler";

/** Clears the site's audit history (audits and their tasks); the site and its settings stay. */
export const DELETE = route<{ ws: string; id: string }>(async (_req, { ws, id }) => {
  await syncRunningAudits(ws, id);
  return clearAuditHistory(id, await getDeps(ws));
});
