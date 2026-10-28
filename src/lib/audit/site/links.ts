import { SafeFetchError, type FetchResult } from "../../fetch/safe-fetch";
import { extractLinks } from "../../crawl/extract";
import { normalizePageUrl } from "../../crawl/url";
import { parseHtml } from "../parse";
import type { Finding } from "../types";
import { inconclusive, siteFinding, type SiteCheckMeta, type SiteContext, type SiteRule, type VerifyBody, type VerifyEnv } from "./types";

const MAX_SOURCES = 10;
const MAX_VERIFY_SOURCES = 5;

const BROKEN: SiteCheckMeta = {
  code: "links/broken-internal",
  severity: "medium",
  kind: "defect",
  certainty: "verified",
  why: "Internal links to error pages send visitors to a dead end and waste crawl requests on URLs that cannot be indexed.",
};
const REDIRECTED: SiteCheckMeta = {
  code: "links/redirected-internal",
  severity: "low",
  kind: "opportunity",
  certainty: "verified",
  why: "Links that go through a redirect still work, but each one costs an extra request. Linking straight to the final URL is cleaner.",
};
const BROKEN_IMAGE: SiteCheckMeta = {
  code: "images/broken-internal",
  severity: "medium",
  kind: "defect",
  certainty: "verified",
  why: "A broken image shows nothing to visitors and cannot appear in image search.",
};
const ORPHAN: SiteCheckMeta = {
  code: "links/orphan-candidate",
  severity: "low",
  kind: "observation",
  certainty: "heuristic",
  why: "Pages with no internal links pointing to them are hard for visitors and crawlers to find. 'Candidate' because Site Sentry only sees links on the pages it crawled.",
};

interface TargetState {
  status: number | null;
  finalUrl: string | null;
  redirectCount: number;
}

/** What is known about a URL's response in this audit: from its own snapshot, or a link check. */
function targetStates(ctx: SiteContext): Map<string, TargetState> {
  const out = new Map<string, TargetState>();
  for (const c of Object.values(ctx.linkChecks)) out.set(c.url, { status: c.status, finalUrl: c.finalUrl, redirectCount: c.redirectCount });
  for (const p of ctx.pages) {
    if (p.status === null) continue;
    out.set(p.url, { status: p.status, finalUrl: p.finalUrl, redirectCount: p.redirectChain.length });
  }
  return out;
}

/** target → pages linking to it (only pages that were actually inspected). */
export function inboundMap(ctx: SiteContext, kind: "link" | "image" = "link"): Map<string, string[]> {
  const inbound = new Map<string, string[]>();
  for (const p of ctx.pages) {
    if (!p.links) continue;
    for (const target of kind === "link" ? p.links.internal : p.links.images) {
      if (target === p.finalUrl) continue;
      const list = inbound.get(target) ?? [];
      list.push(p.finalUrl);
      inbound.set(target, list);
    }
  }
  return inbound;
}

function targetFinding(meta: SiteCheckMeta, target: string, sources: string[], state: TargetState, image: boolean): Finding {
  const sorted = [...new Set(sources)].sort();
  const shown = sorted.slice(0, MAX_SOURCES);
  const what = image ? "image" : "link";
  const broken = meta !== REDIRECTED;
  return siteFinding(image ? brokenImageRule : linksRule, meta, {
    pageUrl: target,
    title: broken
      ? `Broken internal ${what}: HTTP ${state.status}`
      : `Internal links go through a redirect`,
    message: broken
      ? `${sorted.length} page(s) ${image ? "embed" : "link to"} ${target}, which returns HTTP ${state.status}.`
      : `${sorted.length} page(s) link to ${target}, which redirects to ${state.finalUrl}.`,
    observed: broken ? `HTTP ${state.status}` : `${state.redirectCount} redirect(s) to ${state.finalUrl}`,
    expected: broken ? `The ${what} target returns 2xx, or the ${what}s are removed/updated` : "Links point directly at the final URL",
    evidence: {
      snippets: [`${state.status ?? "?"} ${target}${state.finalUrl && state.finalUrl !== target ? ` → ${state.finalUrl}` : ""}`],
      facts: { target, status: state.status, finalUrl: state.finalUrl, linkingPages: sorted.length },
      urls: shown.map((url) => ({ url, detail: image ? "embeds this image" : "links here" })),
    },
    recommendations: broken
      ? image
        ? ["Restore the image file at this URL, or update the pages to reference an existing image."]
        : [
            "If the page moved, redirect this URL (301) to its replacement.",
            "Update the linking pages to point at a working URL, or remove the links.",
          ]
      : [`Update links on the listed pages to point at ${state.finalUrl}.`],
    acceptanceCriteria: broken
      ? [{ id: `${image ? "image" : "link"}.target-ok-or-unlinked`, description: `${target} returns 2xx, or none of the listed pages reference it`, params: { target } }]
      : [{ id: "link.direct-or-unlinked", description: `Listed pages link to ${target} directly without a redirect, or no longer link to it`, params: { target } }],
    scope: { kind: "target", url: target, sources: shown },
    verify: "site",
  });
}

async function fetchStatus(env: VerifyEnv, url: string): Promise<FetchResult> {
  return env.fetch(url, { accept: "status" });
}

/** Do any of these source pages still reference the target? null = could not tell. */
async function stillReferenced(env: VerifyEnv, sources: string[], target: string, image: boolean): Promise<{ still: string[]; error?: string }> {
  const still: string[] = [];
  for (const src of sources.slice(0, MAX_VERIFY_SOURCES)) {
    let res: FetchResult;
    try {
      res = await env.fetch(src, { accept: "html" });
    } catch (e) {
      return { still, error: `${src}: ${(e as Error).message}` };
    }
    if (res.status >= 400) continue; // the linking page itself is gone, so it no longer links
    if (!res.contentTypeAccepted || res.status >= 300) return { still, error: `${src} responded with HTTP ${res.status}` };
    const links = extractLinks(parseHtml(res.body), res.finalUrl, env.origin);
    if ((image ? links.images : links.internal).includes(target)) still.push(src);
  }
  return { still };
}

async function verifyTarget(finding: Finding, env: VerifyEnv, image: boolean): Promise<VerifyBody> {
  if (finding.scope.kind !== "target") return inconclusive("This finding has no link target to re-check.");
  const { url: target, sources } = finding.scope;
  const criterion = finding.acceptanceCriteria[0];
  const redirectCheck = finding.ruleCode === REDIRECTED.code;
  let res: FetchResult | null = null;
  try {
    res = await fetchStatus(env, target);
  } catch (e) {
    if (!(e instanceof SafeFetchError)) return inconclusive(`Unexpected error: ${(e as Error).message}`);
    if (e.code !== "TOO_MANY_REDIRECTS") return inconclusive(`${target} could not be checked: ${e.message}`, { code: e.code, message: e.message });
  }
  const observation = {
    capturedAt: env.now().toISOString(),
    source: env.source,
    finalUrl: res?.finalUrl ?? target,
    httpStatus: res?.status ?? 0,
    facts: { target, status: res?.status ?? null, redirectCount: res?.redirectChain.length ?? null },
    snippets: res ? [`${res.status} ${target}${res.finalUrl !== target ? ` → ${res.finalUrl}` : ""}`] : [],
  };
  const targetFixed = res !== null && (redirectCheck ? res.redirectChain.length === 0 && res.status < 300 : res.status >= 200 && res.status < 400);
  if (targetFixed) {
    return {
      outcome: "resolved",
      reason: `${target} now responds with HTTP ${res!.status}${redirectCheck ? " without redirecting" : ""}.`,
      criteria: [{ id: criterion.id, description: criterion.description, passed: true, actual: `HTTP ${res!.status}` }],
      observation,
    };
  }
  const { still, error } = await stillReferenced(env, sources, target, image);
  if (error) return { ...inconclusive(`The target still fails and a linking page could not be re-checked (${error}).`), observation };
  const passed = still.length === 0;
  return {
    outcome: passed ? "resolved" : "still_failing",
    reason: passed
      ? `${target} still returns HTTP ${res?.status ?? "an error"}, but none of the re-checked pages reference it any more.`
      : `${target} returns HTTP ${res?.status ?? "an error"} and ${still.length} page(s) still reference it.`,
    criteria: [
      {
        id: criterion.id,
        description: criterion.description,
        passed,
        actual: `HTTP ${res?.status ?? "error"}; still referenced by ${still.length ? still.join(", ") : "none"}`,
      },
    ],
    observation,
  };
}

export const linksRule: SiteRule = {
  id: "links",
  name: "Internal links",
  category: "links",
  checks: [BROKEN, REDIRECTED, ORPHAN],
  analyze(ctx) {
    const states = targetStates(ctx);
    const inbound = inboundMap(ctx);
    const findings: Finding[] = [];
    for (const [target, sources] of [...inbound.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const state = states.get(target);
      if (!state || state.status === null) continue; // unknown status: never guessed
      if (state.status >= 400) findings.push(targetFinding(BROKEN, target, sources, state, false));
      else if (state.redirectCount > 0) findings.push(targetFinding(REDIRECTED, target, sources, state, false));
    }

    // Orphan candidates need a link graph: the crawl must have followed links and finished its frontier.
    if (ctx.graphComplete && ctx.maxDepth > 0) {
      const homepage = normalizePageUrl("/", ctx.origin);
      for (const p of ctx.pages) {
        if (p.outcome !== "inspected" || p.via === "link" || p.finalUrl === homepage || p.url === homepage) continue;
        if (p.summary.noindex) continue;
        if ((inbound.get(p.finalUrl)?.length ?? 0) + (inbound.get(p.url)?.length ?? 0) > 0) continue;
        findings.push(
          siteFinding(linksRule, ORPHAN, {
            pageUrl: p.finalUrl,
            title: "Orphan candidate: no internal links found",
            message: `None of the ${ctx.pages.filter((x) => x.links).length} crawled pages link to this page. It was found via the ${p.via === "sitemap" ? "sitemap" : p.via === "important" ? "important-URL list" : "audit's URL list"}.`,
            observed: "0 inbound internal links among crawled pages",
            expected: "At least one internal link from a relevant page",
            evidence: { snippets: [`Discovered via: ${p.via}`], facts: { inboundLinks: 0, crawledPages: ctx.pages.length } },
            recommendations: [
              "Link to this page from a relevant hub, category or navigation page.",
              "If the page is obsolete, redirect or remove it (and drop it from the sitemap).",
            ],
            diagnosis: "This is a candidate only: pages outside the crawl limits may still link here.",
            acceptanceCriteria: [{ id: "links.has-inbound", description: "A later full audit finds at least one internal link to this page", params: {} }],
            scope: { kind: "site", check: "graph" },
            verify: "reaudit",
            expectationKey: `page=${p.finalUrl}`,
          }),
        );
      }
    }
    return findings;
  },
  verify: (finding, env) => verifyTarget(finding, env, false),
};

export const brokenImageRule: SiteRule = {
  id: "images-broken",
  name: "Broken internal images",
  category: "images",
  checks: [BROKEN_IMAGE],
  analyze(ctx) {
    const inbound = inboundMap(ctx, "image");
    const findings: Finding[] = [];
    for (const [target, sources] of [...inbound.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const check = ctx.linkChecks[target];
      if (!check || check.kind !== "image" || check.status === null || check.status < 400) continue;
      findings.push(targetFinding(BROKEN_IMAGE, target, sources, { status: check.status, finalUrl: check.finalUrl, redirectCount: check.redirectCount }, true));
    }
    return findings;
  },
  verify: (finding, env) => verifyTarget(finding, env, true),
};
