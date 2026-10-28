import { z } from "zod";
import { getSettings } from "@/lib/server/queries";
import { updateSettings } from "@/lib/workflow/sites";
import { getDeps } from "@/lib/workspace";
import { body, route } from "../../_lib/handler";

export const GET = route<{ ws: string }>(async (_req, { ws }) => getSettings(ws));

const Put = z.object({
  ruleConfig: z.object({ thinContentWords: z.number().int().min(0).max(5000).optional(), multipleH1: z.enum(["warn", "ignore"]).optional() }).optional(),
  severityOverrides: z.record(z.string().max(80), z.enum(["high", "medium", "low"])).optional(),
});

export const PUT = route<{ ws: string }>(async (req, { ws }) => {
  await updateSettings(await body(req, Put), await getDeps(ws));
  return getSettings(ws);
});
