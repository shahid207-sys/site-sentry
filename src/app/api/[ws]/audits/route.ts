import { z } from "zod";
import { RULE_CATEGORIES, type RuleCategory } from "@/lib/audit/types";
import { createAudit, LIMITS } from "@/lib/crawl/engine";
import { listAudits, summarize } from "@/lib/server/queries";
import { WorkflowError } from "@/lib/workflow/deps";
import { assertLiveScans, getDeps, getStore } from "@/lib/workspace";
import { body, rateLimit, route } from "../../_lib/handler";

export const GET = route<{ ws: string }>(async (req, { ws }) => listAudits(ws, req.nextUrl.searchParams.get("site") ?? undefined));

const Create = z.object({
  siteId: z.string().min(1).max(80),
  mode: z.enum(["single", "list", "sitemap"]),
  urls: z.array(z.string().max(2000)).max(LIMITS.maxListUrls).default([]),
  sitemapUrl: z.string().max(2000).optional(),
  maxPages: z.number().int().min(1).max(LIMITS.maxPages),
  maxDepth: z.number().int().min(0).max(LIMITS.maxDepth),
  categories: z.array(z.enum(RULE_CATEGORIES.map((c) => c.id) as [RuleCategory, ...RuleCategory[]])).min(1, "Choose at least one check category."),
  checkLinks: z.boolean(),
  includeImportant: z.boolean(),
});

export const POST = route<{ ws: string }>(async (req, { ws }) => {
  rateLimit(req, `audit:${ws}`, 10, 60_000);
  assertLiveScans(ws);
  const input = await body(req, Create);
  if (input.mode === "single" && input.urls.length !== 1) throw new WorkflowError("INVALID", "Enter exactly one URL.");
  if (input.mode === "list" && input.urls.length === 0) throw new WorkflowError("INVALID", "Enter at least one URL.");
  const { siteId, ...config } = input;
  const { audit, reused } = await createAudit({ siteId, config: { ...config, urls: config.mode === "sitemap" ? [] : config.urls } }, await getDeps(ws));
  return { audit: summarize(audit, await getStore(ws).read()), reused };
});
