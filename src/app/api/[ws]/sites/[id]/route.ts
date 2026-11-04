import { z } from "zod";
import { getSiteDetail } from "@/lib/server/queries";
import { deleteSiteSchedulesOf } from "@/lib/server/schedules";
import { deleteSite, updateSite } from "@/lib/workflow/sites";
import { getDeps } from "@/lib/workspace";
import { syncRunningAudits } from "../../../_lib/audits";
import { body, route } from "../../../_lib/handler";

type P = { ws: string; id: string };

export const GET = route<P>(async (_req, { ws, id }) => getSiteDetail(ws, id));

const Branding = z.object({ agencyName: z.string().max(500).nullable().optional(), brandColor: z.string().max(20).nullable().optional(), logoDataUrl: z.string().max(160_000).nullable().optional() });
const Patch = z.object({ name: z.string().max(200).optional(), sitemapUrl: z.string().max(2000).nullable().optional(), notes: z.string().max(5000).optional(), branding: Branding.optional(), brandName: z.string().max(200).nullable().optional(), aiAnalysis: z.boolean().optional() });

export const PATCH = route<P>(async (req, { ws, id }) => updateSite(id, await body(req, Patch), await getDeps(ws)));

export const DELETE = route<P>(async (_req, { ws, id }) => {
  await syncRunningAudits(ws, id);
  const out = await deleteSite(id, await getDeps(ws));
  await deleteSiteSchedulesOf(ws, id);
  return out;
});
