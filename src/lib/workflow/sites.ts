import { normaliseUrl } from "../audit/rules/canonical";
import type { RuleConfig, Severity } from "../audit/types";
import { ALL_CHECK_CODES } from "../audit/catalog";
import { isInternal, normalizePageUrl, originOf } from "../crawl/url";
import { SafeFetchError, validateTargetUrl } from "../fetch/safe-fetch";
import type { PageIntent, PageType, Site } from "../model";
import { applyBranding, type BrandingPatch } from "../report/branding";
import { WorkflowError, type Deps } from "./deps";

export const MAX_SITES = 50;
export const MAX_PAGE_INTENTS = 200;
export const PAGE_TYPES: PageType[] = ["home", "service", "location", "product", "category", "article", "landing", "contact", "other"];

function assertWritable(deps: Deps) {
  if (deps.source === "sample") {
    throw new WorkflowError("READ_ONLY", "The sample workspace's sites and URL configuration are read-only. Open your own workspace to add sites.");
  }
}

function toOrigin(input: string): string {
  let url: URL;
  try {
    url = validateTargetUrl(input);
  } catch (e) {
    if (e instanceof SafeFetchError) throw new WorkflowError("INVALID", e.message);
    throw e;
  }
  return originOf(url.toString())!;
}

export async function createSite(input: { name: string; origin: string; sitemapUrl?: string }, deps: Deps): Promise<Site> {
  assertWritable(deps);
  const name = input.name.trim().slice(0, 100);
  if (!name) throw new WorkflowError("INVALID", "Give the site a name.");
  const origin = toOrigin(input.origin);
  const sitemapUrl = input.sitemapUrl?.trim() ? normalizePageUrl(validateSafe(input.sitemapUrl)) ?? undefined : undefined;
  return deps.store.update((d) => {
    if (Object.keys(d.sites).length >= MAX_SITES) throw new WorkflowError("INVALID", `At most ${MAX_SITES} sites per workspace.`);
    const dup = Object.values(d.sites).find((s) => s.origin === origin);
    if (dup) throw new WorkflowError("CONFLICT", `${origin} is already set up as "${dup.name}".`, { siteId: dup.id });
    const site: Site = { id: deps.newId(), name, origin, createdAt: deps.now().toISOString(), ...(sitemapUrl ? { sitemapUrl } : {}) };
    d.sites[site.id] = site;
    return site;
  });
}

function validateSafe(url: string): string {
  try {
    return validateTargetUrl(url).toString();
  } catch (e) {
    if (e instanceof SafeFetchError) throw new WorkflowError("INVALID", e.message);
    throw e;
  }
}

export async function updateSite(id: string, patch: { name?: string; sitemapUrl?: string | null; notes?: string; branding?: BrandingPatch; brandName?: string | null; aiAnalysis?: boolean }, deps: Deps): Promise<Site> {
  assertWritable(deps);
  const sitemapUrl = patch.sitemapUrl ? normalizePageUrl(validateSafe(patch.sitemapUrl)) : patch.sitemapUrl;
  return deps.store.update((d) => {
    const s = d.sites[id];
    if (!s) throw new WorkflowError("NOT_FOUND", "Site not found.");
    if (patch.name !== undefined) {
      const name = patch.name.trim().slice(0, 100);
      if (!name) throw new WorkflowError("INVALID", "Give the site a name.");
      s.name = name;
    }
    if (sitemapUrl === null || sitemapUrl === "") delete s.sitemapUrl;
    else if (sitemapUrl) s.sitemapUrl = sitemapUrl;
    if (patch.notes !== undefined) s.notes = patch.notes.slice(0, 5000);
    if (patch.brandName !== undefined) {
      const brand = patch.brandName?.trim().slice(0, 100);
      if (brand) s.brandName = brand;
      else delete s.brandName;
    }
    if (patch.aiAnalysis === true) s.aiAnalysis = true;
    else if (patch.aiAnalysis === false) delete s.aiAnalysis;
    if (patch.branding) {
      const b = applyBranding(s.branding, patch.branding);
      if ("error" in b) throw new WorkflowError("INVALID", b.error);
      if (Object.keys(b.branding).length) s.branding = b.branding;
      else delete s.branding;
    }
    return s;
  });
}

/** Deletes the site and everything recorded about it. Irreversible; the UI asks for confirmation. */
export async function deleteSite(id: string, deps: Deps): Promise<{ auditsDeleted: number }> {
  assertWritable(deps);
  const auditIds = await deps.store.update((d) => {
    if (!d.sites[id]) throw new WorkflowError("NOT_FOUND", "Site not found.");
    if (Object.values(d.audits).some((a) => a.siteId === id && a.status === "running")) {
      throw new WorkflowError("CONFLICT", "An audit is running for this site. Cancel it first.");
    }
    delete d.sites[id];
    for (const [pid, p] of Object.entries(d.pages)) if (p.siteId === id) delete d.pages[pid];
    for (const [tid, t] of Object.entries(d.tasks)) if (t.siteId === id) delete d.tasks[tid];
    const ids = Object.values(d.audits).filter((a) => a.siteId === id).map((a) => a.id);
    for (const aid of ids) delete d.audits[aid];
    return ids;
  });
  for (const aid of auditIds) await deps.store.deleteAudit(aid);
  return { auditsDeleted: auditIds.length };
}

export interface PageIntentInput {
  url: string;
  pageType?: PageType;
  labels?: string[];
  indexability?: "index" | "noindex" | null;
  canonicalUrl?: string | null;
}

export async function upsertPageIntent(siteId: string, input: PageIntentInput, deps: Deps): Promise<PageIntent> {
  assertWritable(deps);
  const data = await deps.store.read();
  const site = data.sites[siteId];
  if (!site) throw new WorkflowError("NOT_FOUND", "Site not found.");
  const raw = input.url.trim().startsWith("/") ? `${site.origin}${input.url.trim()}` : input.url;
  const url = normalizePageUrl(validateSafe(raw));
  if (!url || !isInternal(url, site.origin)) throw new WorkflowError("INVALID", `The URL must be on ${site.origin}.`);
  let canonicalUrl: string | undefined;
  if (input.canonicalUrl) {
    const c = normaliseUrl(input.canonicalUrl.trim());
    if (!c || !/^https?:\/\//.test(c)) throw new WorkflowError("INVALID", "Expected canonical must be an absolute http(s) URL.");
    canonicalUrl = c;
  }
  if (input.pageType && !PAGE_TYPES.includes(input.pageType)) throw new WorkflowError("INVALID", "Unknown page type.");
  const labels = [...new Set((input.labels ?? []).map((l) => l.trim().slice(0, 40)).filter(Boolean))].slice(0, 10);

  return deps.store.update((d) => {
    const at = deps.now().toISOString();
    const existing = Object.values(d.pages).find((p) => p.siteId === siteId && p.url === url);
    if (!existing && Object.values(d.pages).filter((p) => p.siteId === siteId).length >= MAX_PAGE_INTENTS) {
      throw new WorkflowError("INVALID", `At most ${MAX_PAGE_INTENTS} important URLs per site.`);
    }
    const intent: PageIntent = {
      id: existing?.id ?? deps.newId(),
      siteId,
      url,
      pageType: input.pageType ?? existing?.pageType ?? "other",
      labels: input.labels ? labels : (existing?.labels ?? []),
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
    };
    const indexability = input.indexability === undefined ? existing?.indexability : input.indexability ?? undefined;
    const canon = input.canonicalUrl === undefined ? existing?.canonicalUrl : canonicalUrl;
    if (indexability) intent.indexability = indexability;
    if (canon) intent.canonicalUrl = canon;
    d.pages[intent.id] = intent;
    return intent;
  });
}

export async function deletePageIntent(siteId: string, id: string, deps: Deps): Promise<void> {
  assertWritable(deps);
  await deps.store.update((d) => {
    const p = d.pages[id];
    if (!p || p.siteId !== siteId) throw new WorkflowError("NOT_FOUND", "URL not found.");
    delete d.pages[id];
  });
}

export async function updateSettings(input: { ruleConfig?: Partial<RuleConfig>; severityOverrides?: Record<string, Severity> }, deps: Deps) {
  if (deps.source === "sample") throw new WorkflowError("READ_ONLY", "Sample workspace settings are read-only.");
  const overrides = input.severityOverrides;
  if (overrides) {
    for (const [code, sev] of Object.entries(overrides)) {
      if (!ALL_CHECK_CODES.has(code)) throw new WorkflowError("INVALID", `Unknown rule code ${code}.`);
      if (!["high", "medium", "low"].includes(sev)) throw new WorkflowError("INVALID", `Invalid severity for ${code}.`);
    }
  }
  return deps.store.update((d) => {
    if (input.ruleConfig) {
      const rc = { ...d.settings.ruleConfig, ...input.ruleConfig };
      if (!Number.isInteger(rc.thinContentWords) || rc.thinContentWords < 0 || rc.thinContentWords > 5000) {
        throw new WorkflowError("INVALID", "Thin-content threshold must be a whole number between 0 and 5000.");
      }
      if (rc.multipleH1 !== "warn" && rc.multipleH1 !== "ignore") throw new WorkflowError("INVALID", "Invalid multiple-h1 setting.");
      d.settings.ruleConfig = rc;
    }
    if (overrides) d.settings.severityOverrides = overrides;
    return d.settings;
  });
}
