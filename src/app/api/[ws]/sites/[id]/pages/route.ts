import { z } from "zod";
import type { PageType } from "@/lib/model";
import { PAGE_TYPES, upsertPageIntent } from "@/lib/workflow/sites";
import { getDeps } from "@/lib/workspace";
import { body, route } from "../../../../_lib/handler";

const Upsert = z.object({
  url: z.string().min(1).max(2000),
  pageType: z.enum(PAGE_TYPES as [PageType, ...PageType[]]).optional(),
  labels: z.array(z.string().max(60)).max(20).optional(),
  indexability: z.enum(["index", "noindex"]).nullable().optional(),
  canonicalUrl: z.string().max(2000).nullable().optional(),
});

export const PUT = route<{ ws: string; id: string }>(async (req, { ws, id }) => upsertPageIntent(id, await body(req, Upsert), await getDeps(ws)));
