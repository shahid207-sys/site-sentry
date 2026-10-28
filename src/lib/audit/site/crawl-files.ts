// robots.txt and XML sitemap checks.
import { isAllowed, parseRobots } from "../../crawl/robots";
import { parseSitemap } from "../../crawl/sitemap";
import { normalizePageUrl } from "../../crawl/url";
import { SafeFetchError } from "../../fetch/safe-fetch";
import { pageContext } from "../run";
import { canonicalRule } from "../rules/canonical";
import { indexabilityRule } from "../rules/indexability";
import type { Finding } from "../types";
import { inconclusive, siteFinding, type SiteCheckMeta, type SiteContext, type SiteRule, type VerifyBody, type VerifyEnv } from "./types";

export const GOOGLEBOT = "Googlebot";

const ROBOTS_ERROR: SiteCheckMeta = {
  code: "robots/unreachable",
  severity: "high",
  kind: "defect",
  certainty: "verified",
  why: "Google treats a robots.txt that returns a server error (or cannot be reached) as a temporary block on crawling the whole site.",
};
const ROBOTS_BLOCKS_IMPORTANT: SiteCheckMeta = {
  code: "robots/blocks-important",
  severity: "high",
  kind: "defect",
  certainty: "verified",
  why: "A URL disallowed in robots.txt cannot be crawled, so search engines cannot read its content or directives.",
};
const ROBOTS_NO_SITEMAP: SiteCheckMeta = {
  code: "robots/no-sitemap-directive",
  severity: "low",
  kind: "opportunity",
  certainty: "verified",
  why: "Declaring the sitemap in robots.txt helps every crawler find it, not only those you submit it to.",
};
const SITEMAP_UNREACHABLE: SiteCheckMeta = {
  code: "sitemap/unreachable",
  severity: "medium",
  kind: "defect",
  certainty: "verified",
  why: "A declared sitemap that cannot be fetched gives search engines no list of the site's URLs.",
};
const SITEMAP_INVALID: SiteCheckMeta = {
  code: "sitemap/invalid",
  severity: "medium",
  kind: "defect",
  certainty: "verified",
  why: "Search engines may reject a sitemap that is not well-formed XML or does not follow the sitemap format.",
};
const SITEMAP_BAD_URLS: SiteCheckMeta = {
  code: "sitemap/non-indexable-urls",
  severity: "medium",
  kind: "warning",
  certainty: "verified",
  why: "A sitemap should list only canonical, indexable URLs that return 200. Other entries send mixed signals and waste crawl requests.",
};
const SITEMAP_MISSING: SiteCheckMeta = {
  code: "sitemap/missing-pages",
  severity: "low",
  kind: "observation",
  certainty: "needs_review",
  why: "Indexable pages found by crawling but absent from the sitemap may be intentional, but are often new pages the sitemap generator misses.",
};

const errOf = (e: unknown) =>
  e instanceof SafeFetchError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: (e as Error)?.message ?? "error" };

async function fetchRobots(env: VerifyEnv) {
  const url = `${env.origin}/robots.txt`;
  const res = await env.fetch(url, { accept: "robots" });
  return { url, res };
}

// ---------- robots ----------

function verifyRobots(finding: Finding, env: VerifyEnv): Promise<VerifyBody> {
  const criterion = finding.acceptanceCriteria[0];
  return (async () => {
    let fetched;
    try {
      fetched = await fetchRobots(env);
    } catch (e) {
      if (finding.ruleCode === ROBOTS_ERROR.code) {
        const err = errOf(e);
        return {
          outcome: "still_failing",
          reason: `robots.txt still cannot be fetched: ${err.message}`,
          criteria: [{ id: criterion.id, description: criterion.description, passed: false, actual: err.message }],
          observation: null,
          error: err,
        } satisfies VerifyBody;
      }
      return inconclusive(`robots.txt could not be fetched: ${errOf(e).message}`, errOf(e));
    }
    const { url, res } = fetched;
    const observation = {
      capturedAt: env.now().toISOString(),
      source: env.source,
      finalUrl: res.finalUrl,
      httpStatus: res.status,
      facts: { status: res.status },
      snippets: res.body ? res.body.split(/\r?\n/).slice(0, 30) : [`HTTP ${res.status} ${url}`],
    };
    if (finding.ruleCode === ROBOTS_ERROR.code) {
      const passed = res.status < 500;
      return {
        outcome: passed ? "resolved" : "still_failing",
        reason: passed ? `robots.txt now responds with HTTP ${res.status}.` : `robots.txt still responds with HTTP ${res.status}.`,
        criteria: [{ id: criterion.id, description: criterion.description, passed, actual: `HTTP ${res.status}` }],
        observation,
      };
    }
    if (res.status >= 500) return { ...inconclusive(`robots.txt returned HTTP ${res.status}.`), observation };
    const parsed = parseRobots(res.status >= 400 ? "" : res.body);
    if (finding.ruleCode === ROBOTS_NO_SITEMAP.code) {
      const passed = parsed.sitemaps.length > 0;
      return {
        outcome: passed ? "resolved" : "still_failing",
        reason: passed ? `robots.txt now declares ${parsed.sitemaps.length} sitemap(s).` : "robots.txt still has no Sitemap: line.",
        criteria: [{ id: criterion.id, description: criterion.description, passed, actual: parsed.sitemaps.join(", ") || "no Sitemap: line" }],
        observation,
      };
    }
    const target = String(criterion.params.url);
    const decision = isAllowed(parsed, GOOGLEBOT, target);
    return {
      outcome: decision.allowed ? "resolved" : "still_failing",
      reason: decision.allowed ? `Googlebot may now crawl ${target}.` : `${target} is still disallowed (${decision.matchedRule}).`,
      criteria: [{ id: criterion.id, description: criterion.description, passed: decision.allowed, actual: decision.matchedRule ?? "no matching rule (allowed)" }],
      observation,
    };
  })();
}

export const robotsRule: SiteRule = {
  id: "robots",
  name: "robots.txt",
  category: "crawlability",
  checks: [ROBOTS_ERROR, ROBOTS_BLOCKS_IMPORTANT, ROBOTS_NO_SITEMAP],
  analyze(ctx) {
    const r = ctx.robots;
    if (!r) return [];
    const findings: Finding[] = [];
    const base = { scope: { kind: "site" as const, check: "robots" as const }, verify: "site" as const, pageUrl: r.url };
    if (r.outcome === "error") {
      findings.push(
        siteFinding(robotsRule, ROBOTS_ERROR, {
          ...base,
          title: "robots.txt returns a server error",
          message: `${r.url} ${r.status ? `returned HTTP ${r.status}` : `could not be fetched (${r.error?.message})`}. Site Sentry only audited the URLs it was given and did not follow links.`,
          observed: r.status ? `HTTP ${r.status}` : (r.error?.message ?? "unreachable"),
          expected: "HTTP 200 with the robots rules, or 404 if there are none",
          evidence: { snippets: [`${r.status ?? "error"} ${r.url}`], facts: { status: r.status } },
          recommendations: ["Fix the server or CDN rule that makes /robots.txt fail.", "If the site has no rules, return 404 (allow all) rather than an error."],
          acceptanceCriteria: [{ id: "robots.reachable", description: "/robots.txt responds with a status below 500", params: {} }],
        }),
      );
      return findings;
    }
    if (r.outcome !== "ok") return findings;
    const parsed = parseRobots(r.body);
    for (const url of Object.keys(ctx.intents).sort()) {
      const decision = isAllowed(parsed, GOOGLEBOT, url);
      if (decision.allowed) continue;
      findings.push(
        siteFinding(robotsRule, ROBOTS_BLOCKS_IMPORTANT, {
          ...base,
          pageUrl: url,
          title: "Important URL is blocked by robots.txt",
          message: `robots.txt disallows Googlebot from crawling ${url}.`,
          observed: decision.matchedRule ?? "disallowed",
          expected: "Important URLs are crawlable by Googlebot",
          evidence: { snippets: [decision.matchedRule ?? ""], facts: { url, rule: decision.matchedRule } },
          recommendations: [
            "Narrow or remove the Disallow rule, or add a more specific Allow rule for this URL.",
            "If the page should not be indexed, use noindex instead: a robots.txt block stops crawlers from seeing the noindex.",
          ],
          acceptanceCriteria: [{ id: "robots.allows-url", description: `robots.txt allows Googlebot to crawl ${url}`, params: { url } }],
          expectationKey: `url=${url}`,
        }),
      );
    }
    if (parsed.sitemaps.length === 0) {
      findings.push(
        siteFinding(robotsRule, ROBOTS_NO_SITEMAP, {
          ...base,
          title: "robots.txt does not declare a sitemap",
          message: "robots.txt has no Sitemap: line.",
          observed: "No Sitemap: directive",
          expected: "Sitemap: https://…/sitemap.xml",
          evidence: { snippets: r.body.split(/\r?\n/).slice(0, 15), facts: { sitemaps: 0 } },
          recommendations: ["Add a Sitemap: line with the absolute URL of the XML sitemap."],
          acceptanceCriteria: [{ id: "robots.declares-sitemap", description: "robots.txt declares at least one Sitemap", params: {} }],
        }),
      );
    }
    return findings;
  },
  verify: verifyRobots,
};

// ---------- sitemap ----------

async function verifySitemap(finding: Finding, env: VerifyEnv): Promise<VerifyBody> {
  const criterion = finding.acceptanceCriteria[0];
  const sitemapUrl = String(criterion.params.sitemap);
  let res;
  try {
    res = await env.fetch(sitemapUrl, { accept: "xml" });
  } catch (e) {
    return inconclusive(`${sitemapUrl} could not be fetched: ${errOf(e).message}`, errOf(e));
  }
  const observation = {
    capturedAt: env.now().toISOString(),
    source: env.source,
    finalUrl: res.finalUrl,
    httpStatus: res.status,
    facts: { status: res.status, contentType: res.contentType },
    snippets: [`HTTP ${res.status} ${sitemapUrl} (${res.contentType || "no content-type"})`],
  };
  const fetchedOk = res.status >= 200 && res.status < 300 && res.contentTypeAccepted;
  if (finding.ruleCode === SITEMAP_UNREACHABLE.code) {
    return {
      outcome: fetchedOk ? "resolved" : "still_failing",
      reason: fetchedOk ? "The sitemap is now served as XML." : `The sitemap still responds with HTTP ${res.status} (${res.contentType || "no content-type"}).`,
      criteria: [{ id: criterion.id, description: criterion.description, passed: fetchedOk, actual: `HTTP ${res.status}, ${res.contentType || "no content-type"}` }],
      observation,
    };
  }
  if (!fetchedOk) return { ...inconclusive(`The sitemap responded with HTTP ${res.status}; its contents cannot be re-checked.`), observation };
  const parsed = parseSitemap(res.body);
  if (finding.ruleCode === SITEMAP_INVALID.code) {
    const passed = parsed.errors.length === 0;
    return {
      outcome: passed ? "resolved" : "still_failing",
      reason: passed ? `The sitemap parses cleanly (${parsed.locs.length} entries).` : `The sitemap still has errors: ${parsed.errors[0]}`,
      criteria: [{ id: criterion.id, description: criterion.description, passed, actual: parsed.errors.join("; ") || "no errors" }],
      observation: { ...observation, snippets: [...observation.snippets, ...parsed.errors] },
    };
  }
  const listed = new Set(parsed.locs.map((l) => normalizePageUrl(l)).filter(Boolean) as string[]);
  const urls = finding.scope.kind === "pages" ? finding.scope.urls : [];
  if (finding.ruleCode === SITEMAP_MISSING.code) {
    const missing = urls.filter((u) => !listed.has(u));
    const passed = missing.length === 0;
    return {
      outcome: passed ? "resolved" : "still_failing",
      reason: passed ? "All listed pages are now in the sitemap." : `${missing.length} page(s) are still missing from the sitemap.`,
      criteria: [{ id: criterion.id, description: criterion.description, passed, actual: missing.length ? `missing: ${missing.join(", ")}` : "all present" }],
      observation,
    };
  }
  // Non-indexable URLs: each must be either gone from the sitemap, or now return 200 and be indexable + self-canonical.
  const stillBad: string[] = [];
  for (const url of urls.filter((u) => listed.has(u)).slice(0, 10)) {
    try {
      const page = await env.fetch(url, { accept: "html" });
      if (page.status !== 200 || page.redirectChain.length || !page.contentTypeAccepted) {
        stillBad.push(`${url} (HTTP ${page.status}${page.redirectChain.length ? ", redirects" : ""})`);
        continue;
      }
      const ctx = pageContext({ html: page.body, pageUrl: page.finalUrl, headers: page.headers }, env.config) as Parameters<typeof indexabilityRule.observe>[0];
      const idx = indexabilityRule.observe(ctx).facts;
      const can = canonicalRule.observe(ctx).facts;
      if (idx.metaNoindex || idx.headerNoindex) stillBad.push(`${url} (noindex)`);
      else if (can.canonicalCount === 1 && !can.canonicalSelf) stillBad.push(`${url} (canonical → ${can.canonicalResolved})`);
    } catch (e) {
      return { ...inconclusive(`${url} could not be fetched: ${errOf(e).message}`, errOf(e)), observation };
    }
  }
  const passed = stillBad.length === 0;
  return {
    outcome: passed ? "resolved" : "still_failing",
    reason: passed ? "Every flagged sitemap entry is now indexable or has been removed." : `${stillBad.length} flagged sitemap entr(ies) are still non-indexable.`,
    criteria: [{ id: criterion.id, description: criterion.description, passed, actual: stillBad.join("; ") || "all fixed or removed" }],
    observation,
  };
}

export const sitemapRule: SiteRule = {
  id: "sitemap",
  name: "XML sitemap",
  category: "crawlability",
  checks: [SITEMAP_UNREACHABLE, SITEMAP_INVALID, SITEMAP_BAD_URLS, SITEMAP_MISSING],
  analyze(ctx: SiteContext) {
    const sm = ctx.sitemap;
    if (!sm) return [];
    const findings: Finding[] = [];
    const base = { scope: { kind: "site" as const, check: "sitemap" as const }, verify: "site" as const, pageUrl: sm.url };
    const fetchedOk = sm.status !== null && sm.status >= 200 && sm.status < 300 && sm.kind !== null;
    if (!fetchedOk) {
      // A missing /sitemap.xml that nobody declared is not a defect.
      if (sm.via === "default" && sm.status === 404) return findings;
      findings.push(
        siteFinding(sitemapRule, SITEMAP_UNREACHABLE, {
          ...base,
          title: "Sitemap cannot be retrieved",
          message: `${sm.url} (${sm.via === "robots" ? "declared in robots.txt" : sm.via === "config" ? "configured for this site" : "requested by this audit"}) ${sm.error ? `failed: ${sm.error.message}` : `returned HTTP ${sm.status} (${sm.contentType || "no content-type"})`}.`,
          observed: sm.error ? sm.error.message : `HTTP ${sm.status}, ${sm.contentType || "no content-type"}`,
          expected: "HTTP 200 with an XML content type",
          evidence: { snippets: [`${sm.status ?? "error"} ${sm.url}`], facts: { status: sm.status, contentType: sm.contentType } },
          recommendations: ["Make sure the sitemap URL is generated and served as application/xml or text/xml.", "Update robots.txt and Search Console if the sitemap moved."],
          acceptanceCriteria: [{ id: "sitemap.reachable", description: `${sm.url} returns 200 with an XML content type`, params: { sitemap: sm.url } }],
        }),
      );
      return findings;
    }
    const errors = [...sm.errors, ...sm.children.flatMap((c) => c.errors.map((e) => `${c.url}: ${e}`))];
    if (errors.length) {
      findings.push(
        siteFinding(sitemapRule, SITEMAP_INVALID, {
          ...base,
          title: "Sitemap has XML or format errors",
          message: `${errors.length} problem(s) found while parsing the sitemap.`,
          observed: errors[0],
          expected: "Well-formed XML with a <urlset> or <sitemapindex> root and absolute <loc> URLs",
          evidence: { snippets: errors.slice(0, 8), facts: { errorCount: errors.length } },
          recommendations: ["Fix the reported XML errors; escape & as &amp; in URLs.", "Regenerate the sitemap with the CMS or a sitemap plugin rather than by hand."],
          acceptanceCriteria: [{ id: "sitemap.well-formed", description: "The sitemap parses without errors", params: { sitemap: sm.url } }],
        }),
      );
    }

    const listed = new Set(sm.urls);
    const byUrl = new Map(ctx.pages.map((p) => [p.url, p]));
    const bad: { url: string; detail: string }[] = [];
    for (const url of sm.urls) {
      const p = byUrl.get(url);
      const check = ctx.linkChecks[url];
      if (p) {
        if (p.status !== null && p.status >= 400) bad.push({ url, detail: `HTTP ${p.status}` });
        else if (p.redirectChain.length) bad.push({ url, detail: `redirects to ${p.finalUrl}` });
        else if (p.summary.noindex) bad.push({ url, detail: "noindex" });
        else if (p.summary.canonicalSelf === false) bad.push({ url, detail: `canonical → ${p.summary.canonical}` });
      } else if (check && check.status !== null) {
        if (check.status >= 400) bad.push({ url, detail: `HTTP ${check.status}` });
        else if (check.redirectCount) bad.push({ url, detail: `redirects to ${check.finalUrl}` });
      }
    }
    if (bad.length) {
      const shown = bad.slice(0, 20);
      findings.push(
        siteFinding(sitemapRule, SITEMAP_BAD_URLS, {
          ...base,
          title: `Sitemap lists ${bad.length} non-indexable URL(s)`,
          message: "These sitemap entries return errors, redirect, are noindex or canonicalise elsewhere.",
          observed: shown.map((b) => `${b.url}: ${b.detail}`).slice(0, 3).join("; ") + (bad.length > 3 ? "; …" : ""),
          expected: "Only 200, indexable, self-canonical URLs in the sitemap",
          evidence: { snippets: shown.map((b) => `${b.url} — ${b.detail}`), facts: { count: bad.length }, urls: shown },
          recommendations: ["Remove these entries from the sitemap, or fix each URL so it is indexable.", "For redirected entries, list the final URL instead."],
          acceptanceCriteria: [{ id: "sitemap.entries-indexable", description: "Each flagged entry is removed from the sitemap or is now 200, indexable and self-canonical", params: { sitemap: sm.url } }],
          scope: { kind: "pages", urls: shown.map((b) => b.url) },
        }),
      );
    }

    if (ctx.maxDepth > 0 && !sm.children.some((c) => c.error) && sm.urlCount <= sm.urls.length) {
      const missing = ctx.pages
        .filter((p) => p.via === "link" && p.outcome === "inspected" && !p.redirectChain.length && !p.summary.noindex && p.summary.canonicalSelf !== false && !listed.has(p.finalUrl))
        .map((p) => p.finalUrl)
        .sort();
      if (missing.length) {
        const shown = missing.slice(0, 20);
        findings.push(
          siteFinding(sitemapRule, SITEMAP_MISSING, {
            ...base,
            title: `${missing.length} crawled indexable page(s) are not in the sitemap`,
            message: "Pages found by following internal links are absent from the sitemap. This may be intentional.",
            observed: `${missing.length} page(s) not listed`,
            expected: "Every indexable page you want found is in the sitemap",
            evidence: { snippets: shown, facts: { count: missing.length }, urls: shown.map((url) => ({ url, detail: "crawled, indexable, not in sitemap" })) },
            recommendations: ["Check the sitemap generator includes these page types.", "Ignore (Won't fix) if they are deliberately excluded."],
            acceptanceCriteria: [{ id: "sitemap.includes-pages", description: "Each listed page appears in the sitemap", params: { sitemap: sm.url } }],
            scope: { kind: "pages", urls: shown },
          }),
        );
      }
    }
    return findings;
  },
  verify: verifySitemap,
};
