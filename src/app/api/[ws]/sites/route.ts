import { z } from "zod";
import { getOverview } from "@/lib/server/queries";
import { createSite } from "@/lib/workflow/sites";
import { getDeps } from "@/lib/workspace";
import { body, rateLimit, route } from "../../_lib/handler";

export const GET = route<{ ws: string }>(async (_req, { ws }) => (await getOverview(ws)).sites);

const Create = z.object({ name: z.string().max(200), origin: z.string().max(2000), sitemapUrl: z.string().max(2000).optional() });

export const POST = route<{ ws: string }>(async (req, { ws }) => {
  // The public homepage form creates sites, so cap how fast one client can add them.
  rateLimit(req, `site:${ws}`, 20, 60_000);
  return createSite(await body(req, Create), await getDeps(ws));
});
