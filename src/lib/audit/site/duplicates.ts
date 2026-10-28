import { SafeFetchError } from "../../fetch/safe-fetch";
import { pageContext } from "../run";
import { metaDescriptionRule } from "../rules/meta-description";
import { titleRule } from "../rules/title";
import type { Finding } from "../types";
import { inconclusive, siteFinding, type SiteCheckMeta, type SiteRule, type VerifyBody } from "./types";

export const MAX_GROUP_URLS = 20;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

const TITLE: SiteCheckMeta = {
  code: "duplicates/title",
  severity: "medium",
  kind: "warning",
  certainty: "verified",
  why: "When several indexable pages share a title, searchers and search engines cannot tell them apart from the result alone, and the pages may compete for the same queries.",
};
const DESCRIPTION: SiteCheckMeta = {
  code: "duplicates/description",
  severity: "low",
  kind: "opportunity",
  certainty: "verified",
  why: "Repeated meta descriptions usually come from a template default and do not describe each page.",
};

type Field = "title" | "description";

function analyzeField(field: Field, pages: Parameters<SiteRule["analyze"]>[0]["pages"]): Finding[] {
  const groups = new Map<string, { value: string; urls: string[] }>();
  for (const p of pages) {
    if (p.outcome !== "inspected" || p.truncated) continue;
    // Pages that are noindex or canonicalise elsewhere are expected to duplicate their canonical's metadata.
    if (p.summary.noindex || p.summary.canonicalSelf === false) continue;
    const value = field === "title" ? p.summary.title : p.summary.description;
    if (!value) continue;
    const key = norm(value);
    const g = groups.get(key) ?? { value, urls: [] };
    g.urls.push(p.finalUrl);
    groups.set(key, g);
  }
  const meta = field === "title" ? TITLE : DESCRIPTION;
  const label = field === "title" ? "title" : "meta description";
  return [...groups.entries()]
    .filter(([, g]) => new Set(g.urls).size > 1)
    .map(([key, g]) => {
      const urls = [...new Set(g.urls)].sort();
      const shown = urls.slice(0, MAX_GROUP_URLS);
      return siteFinding(duplicatesRule, meta, {
        pageUrl: urls[0],
        title: `${urls.length} pages share the same ${label}`,
        message: `These indexable pages all use the ${label} "${g.value}".`,
        observed: `"${g.value}" on ${urls.length} pages`,
        expected: `A unique ${label} on each indexable page`,
        evidence: {
          snippets: [`${field === "title" ? "<title>" : '<meta name="description" content="'}${g.value}${field === "title" ? "</title>" : '">'}`],
          facts: { value: g.value, pageCount: urls.length },
          urls: shown.map((url) => ({ url, detail: `same ${label}` })),
        },
        recommendations: [
          `Write a ${label} for each page that names what is specific to it (product, service, location).`,
          "If the pages are true duplicates, consolidate them or canonicalise to one.",
        ],
        diagnosis: "Usually a template default applied where the page-specific field was left empty.",
        acceptanceCriteria: [
          { id: `duplicates.${field}-unique`, description: `None of these pages share the ${label} "${g.value}"`, params: { value: key } },
        ],
        scope: { kind: "pages", urls: shown },
        verify: "site",
        expectationKey: `value=${key}`,
      });
    });
}

async function verifyField(field: Field, finding: Finding, env: Parameters<NonNullable<SiteRule["verify"]>>[1]): Promise<VerifyBody> {
  if (finding.scope.kind !== "pages") return inconclusive("This finding has no page group to re-check.");
  const key = String(finding.acceptanceCriteria[0]?.params.value ?? "");
  const rule = field === "title" ? titleRule : metaDescriptionRule;
  const results: { url: string; value: string | null }[] = [];
  for (const url of finding.scope.urls) {
    try {
      const res = await env.fetch(url, { accept: "html" });
      if (res.status < 200 || res.status >= 300 || !res.contentTypeAccepted) {
        return inconclusive(`${url} responded with HTTP ${res.status}; the group cannot be fully re-checked.`);
      }
      const ctx = pageContext({ html: res.body, pageUrl: res.finalUrl, headers: res.headers }, env.config);
      const facts = rule.observe(ctx as Parameters<typeof rule.observe>[0]).facts as Record<string, unknown>;
      const v = field === "title" ? facts.titleText : facts.descriptionText;
      results.push({ url, value: typeof v === "string" ? v : null });
    } catch (e) {
      const err = e instanceof SafeFetchError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: (e as Error)?.message ?? "error" };
      return inconclusive(`${url} could not be fetched: ${err.message}`, err);
    }
  }
  const still = results.filter((r) => r.value !== null && norm(r.value) === key);
  const passed = still.length <= 1;
  const criterion = finding.acceptanceCriteria[0];
  return {
    outcome: passed ? "resolved" : "still_failing",
    reason: passed
      ? `At most one of the ${results.length} pages still uses the original value.`
      : `${still.length} of ${results.length} pages still share the original value.`,
    criteria: [{ id: criterion.id, description: criterion.description, passed, actual: results.map((r) => `${r.url}: ${r.value === null ? "none" : `"${r.value}"`}`).join("\n") }],
    observation: {
      capturedAt: env.now().toISOString(),
      source: env.source,
      finalUrl: finding.scope.urls[0],
      httpStatus: 200,
      facts: Object.fromEntries(results.map((r) => [r.url, r.value])),
      snippets: results.map((r) => `${r.url} → ${r.value ?? "(none)"}`),
    },
  };
}

export const duplicatesRule: SiteRule = {
  id: "duplicates",
  name: "Duplicate titles & descriptions",
  category: "content",
  checks: [TITLE, DESCRIPTION],
  analyze: (ctx) => [...analyzeField("title", ctx.pages), ...analyzeField("description", ctx.pages)],
  verify: (finding, env) => verifyField(finding.ruleCode === TITLE.code ? "title" : "description", finding, env),
};
