import { getAuditDetail } from "@/lib/server/queries";
import { deleteAudit } from "@/lib/workflow/audits";
import { getDeps } from "@/lib/workspace";
import { route } from "../../../_lib/handler";

export const GET = route<{ ws: string; id: string }>(async (_req, { ws, id }) => getAuditDetail(ws, id));

export const DELETE = route<{ ws: string; id: string }>(async (_req, { ws, id }) => deleteAudit(id, await getDeps(ws)));
