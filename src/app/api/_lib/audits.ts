import "server-only";
import { z } from "zod";
import { RULE_CATEGORIES, type RuleCategory } from "@/lib/audit/types";
import { clampToLegacyEngine, createAudit, LIMITS } from "@/lib/crawl/engine";
import { MAX_SCOPE_RULES, normaliseSubfolder, PROFILE_IDS, resolveProfile, type ScopeRules } from "@/lib/crawl/profiles";
import { regexProblem } from "@/lib/crawl/scope-rules";
import { crawlerV2Enabled, getCrawlQueue, startCrawl, type CrawlAuthInput } from "@/lib/crawl/v2/audit-bridge";
import { secretKey } from "@/lib/crawl/v2/secrets";
import { getDb } from "@/lib/db/client";
import type { AuditConfig, AuditRun, Workspace } from "@/lib/model";
import { WorkflowError } from "@/lib/workflow/deps";
import { getDeps, getStore } from "@/lib/workspace";

export const CATEGORY_IDS = RULE_CATEGORIES.map((c) => c.id) as [RuleCategory, ...RuleCategory[]];

// Length and safety are checked by regexProblem in scopeFrom, which names the rule; this only bounds the payload.
const Rules = z.array(z.string().max(10_000)).max(MAX_SCOPE_RULES).default([]);

export const AuditRequest = z.object({
  siteId: z.string().min(1).max(80),
  mode: z.enum(["single", "list", "sitemap"]),
  urls: z.array(z.string().max(2000)).max(LIMITS.maxListUrls).default([]),
  sitemapUrl: z.string().max(2000).optional(),
  profile: z.enum(PROFILE_IDS),
  /** Full-site and Custom only; the other profiles reject a value that differs from theirs. */
  budget: z.number().int().optional(),
  /** Custom only; null = unlimited. */
  maxDepth: z.number().int().nullable().optional(),
  scope: z.object({ include: Rules, exclude: Rules, subfolder: z.string().max(500).optional() }).optional(),
  auth: z
    .object({
      username: z.string().min(1).max(200).refine((u) => !u.includes(":"), "A basic-auth username cannot contain a colon."),
      password: z.string().min(1).max(500),
    })
    .optional(),
  /** Intent for AI crawlers (AIS-002); omitted = not set. */
  aiCrawlers: z.enum(["allow", "block"]).optional(),
  categories: z.array(z.enum(CATEGORY_IDS)).min(1, "Choose at least one check category."),
  checkLinks: z.boolean(),
  includeImportant: z.boolean(),
});
export type AuditRequest = z.infer<typeof AuditRequest>;

function scopeFrom(input: NonNullable<AuditRequest["scope"]>): ScopeRules | undefined {
  for (const [kind, list] of [["Include", input.include], ["Exclude", input.exclude]] as const) {
    list.forEach((rule, i) => {
      const problem = regexProblem(rule);
      if (problem) throw new WorkflowError("INVALID", `${kind} rule ${i + 1}: ${problem}`);
    });
  }
  let subfolder: string | undefined;
  if (input.subfolder?.trim()) {
    subfolder = normaliseSubfolder(input.subfolder) ?? undefined;
    if (!subfolder) throw new WorkflowError("INVALID", "The subfolder must be a path such as /blog/.");
  }
  if (!input.include.length && !input.exclude.length && !subfolder) return undefined;
  return { include: input.include, exclude: input.exclude, ...(subfolder ? { subfolder } : {}) };
}

/** The request's problems that do not depend on the store (profile, scope rules, crawler v2 needs); throws INVALID. */
export function checkAuditRequest(ws: Workspace, input: AuditRequest) {
  if (input.mode === "single" && input.urls.length !== 1) throw new WorkflowError("INVALID", "Enter exactly one URL.");
  if (input.mode === "list" && input.urls.length === 0) throw new WorkflowError("INVALID", "Enter at least one URL.");
  let limits: ReturnType<typeof resolveProfile>;
  try {
    limits = resolveProfile({ profile: input.profile, budget: input.budget, maxDepth: input.maxDepth });
  } catch (e) {
    throw new WorkflowError("INVALID", (e as Error).message);
  }
  if ((input.scope || input.auth) && input.profile !== "custom") throw new WorkflowError("INVALID", "Scope rules and basic auth are part of the Custom profile.");
  const scope = input.scope ? scopeFrom(input.scope) : undefined;

  const v2 = crawlerV2Enabled(ws);
  if (!v2 && (scope || input.auth)) {
    throw new WorkflowError("INVALID", "Scope rules and basic auth need crawler v2, which is off on this server (CRAWLER_V2).");
  }
  // Checked before the audit exists, so a missing key cannot leave an audit with no crawl behind it.
  if (v2 && input.auth && !secretKey()) {
    throw new WorkflowError("INVALID", "Basic auth needs CRAWLER_SECRET_KEY set on the server, so the password can be stored encrypted.");
  }
  return { limits, scope, v2 };
}

/**
 * Validate a request against its crawl profile and start the audit: on crawler v2 when it is on, else on the
 * in-request engine with the profile clamped to what that engine can run (and an engine_limit note saying so).
 */
export async function launchAudit(ws: Workspace, input: AuditRequest): Promise<{ audit: AuditRun; reused: boolean }> {
  const { limits, scope, v2 } = checkAuditRequest(ws, input);
  const { siteId, mode, urls, sitemapUrl, categories, checkLinks, includeImportant } = input;
  let config: AuditConfig = {
    mode,
    urls: mode === "sitemap" ? [] : urls,
    ...(sitemapUrl ? { sitemapUrl } : {}),
    profile: limits.profile,
    maxPages: limits.budget,
    maxDepth: limits.maxDepth,
    ...(scope ? { scope } : {}),
    ...(input.auth ? { authUser: input.auth.username } : {}),
    ...(v2 && input.aiCrawlers ? { aiCrawlers: input.aiCrawlers } : {}),
    categories,
    checkLinks,
    includeImportant,
  };
  let coverage: AuditRun["coverage"] = [];
  if (!v2) ({ config, coverage } = clampToLegacyEngine(config));

  const { audit: created, reused } = await createAudit({ siteId, config, coverage }, await getDeps(ws));
  if (!v2 || reused) return { audit: created, reused };
  // Crawler v2: the worker process runs the crawl; the step endpoint only reports its progress.
  const store = getStore(ws);
  const site = (await store.read()).sites[siteId];
  const auth: CrawlAuthInput | undefined = input.auth;
  return { audit: await startCrawl(getDb(), getCrawlQueue(), store, ws, created, site.origin, { auth }), reused };
}
