import { z } from "zod";
import { bulkUpdateTasks } from "@/lib/workflow/tasks";
import { getDeps } from "@/lib/workspace";
import { body, route } from "../../../_lib/handler";

const Bulk = z.object({
  ids: z.array(z.string().max(80)).min(1).max(200),
  patch: z.object({
    workflowStatus: z.enum(["open", "triaged", "in_progress", "ready_to_verify", "resolved", "wont_fix"]).optional(),
    owner: z.string().max(100).nullable().optional(),
    wontFixReason: z.string().max(2000).optional(),
  }),
});

export const POST = route<{ ws: string }>(async (req, { ws }) => {
  const { ids, patch } = await body(req, Bulk);
  return bulkUpdateTasks(ids, patch, await getDeps(ws));
});
