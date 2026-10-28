import { z } from "zod";
import { getTask } from "@/lib/server/queries";
import { deleteTask, updateTask } from "@/lib/workflow/tasks";
import { getDeps } from "@/lib/workspace";
import { body, route } from "../../../_lib/handler";

type P = { ws: string; id: string };

export const GET = route<P>(async (_req, { ws, id }) => getTask(ws, id));

const Patch = z.object({
  title: z.string().max(200).optional(),
  owner: z.string().max(100).nullable().optional(),
  notes: z.string().max(10_000).optional(),
  manualChecks: z.array(z.object({ id: z.string().max(40), text: z.string().max(500), done: z.boolean() })).max(30).optional(),
  workflowStatus: z.enum(["open", "triaged", "in_progress", "ready_to_verify", "resolved", "wont_fix"]).optional(),
  wontFixReason: z.string().max(2000).optional(),
});

export const PATCH = route<P>(async (req, { ws, id }) => {
  await updateTask(id, await body(req, Patch), await getDeps(ws));
  return getTask(ws, id);
});

export const DELETE = route<P>(async (_req, { ws, id }) => {
  await deleteTask(id, await getDeps(ws));
  return { ok: true };
});
