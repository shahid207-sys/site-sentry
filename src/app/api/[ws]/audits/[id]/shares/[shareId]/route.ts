import { revokeAuditShare } from "@/lib/server/report";
import { route } from "../../../../../_lib/handler";

/** Turns a share link off at once. */
export const DELETE = route<{ ws: string; id: string; shareId: string }>(async (_req, { ws, id, shareId }) => revokeAuditShare(ws, id, shareId));
