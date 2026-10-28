import { getTask } from "@/lib/server/queries";
import { WorkflowError } from "@/lib/workflow/deps";
import { verifyTask } from "@/lib/workflow/tasks";
import { assertLiveScans, getDeps, getStore } from "@/lib/workspace";
import { rateLimit, route } from "../../../../_lib/handler";

/** Re-fetch the affected URLs and evaluate each item's frozen acceptance criteria. */
export const POST = route<{ ws: string; id: string }>(async (req, { ws, id }) => {
  rateLimit(req, `verify:${ws}`, 30, 60_000);
  assertLiveScans(ws);
  const data = await getStore(ws).read();
  const task = data.tasks[id];
  if (!task) throw new WorkflowError("NOT_FOUND", "Task not found.");
  await verifyTask(id, await getDeps(ws), { config: data.settings.ruleConfig, origin: data.sites[task.siteId]?.origin ?? "" });
  return getTask(ws, id);
});
