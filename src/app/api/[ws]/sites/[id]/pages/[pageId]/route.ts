import { deletePageIntent } from "@/lib/workflow/sites";
import { getDeps } from "@/lib/workspace";
import { route } from "../../../../../_lib/handler";

export const DELETE = route<{ ws: string; id: string; pageId: string }>(async (_req, { ws, id, pageId }) => {
  await deletePageIntent(id, pageId, await getDeps(ws));
  return { ok: true };
});
