import { z } from "zod";
import { listTasks } from "@/lib/server/queries";
import { createTask, MAX_TASK_ITEMS } from "@/lib/workflow/tasks";
import { getDeps } from "@/lib/workspace";
import { body, route } from "../../_lib/handler";

export const GET = route<{ ws: string }>(async (_req, { ws }) => listTasks(ws));

const Create = z.object({
  auditId: z.string().min(1).max(80),
  fingerprints: z.array(z.string().min(1).max(200)).min(1).max(MAX_TASK_ITEMS),
  title: z.string().max(200).optional(),
  owner: z.string().max(100).nullable().optional(),
  notes: z.string().max(10_000).optional(),
});

export const POST = route<{ ws: string }>(async (req, { ws }) => createTask(await body(req, Create), await getDeps(ws)));
