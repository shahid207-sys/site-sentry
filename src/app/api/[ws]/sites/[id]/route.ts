import { z } from "zod";
import { getSiteDetail } from "@/lib/server/queries";
import { deleteSite, updateSite } from "@/lib/workflow/sites";
import { getDeps } from "@/lib/workspace";
import { body, route } from "../../../_lib/handler";

type P = { ws: string; id: string };

export const GET = route<P>(async (_req, { ws, id }) => getSiteDetail(ws, id));

const Patch = z.object({ name: z.string().max(200).optional(), sitemapUrl: z.string().max(2000).nullable().optional(), notes: z.string().max(5000).optional() });

export const PATCH = route<P>(async (req, { ws, id }) => updateSite(id, await body(req, Patch), await getDeps(ws)));

export const DELETE = route<P>(async (_req, { ws, id }) => deleteSite(id, await getDeps(ws)));
