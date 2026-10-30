// The spec's rule contract (docs/SPEC.md "Rule engine and rule catalog"). Rules are pure: they read the stored
// snapshot (page rules) or a compact projection of the whole crawl (site rules), never the network or the clock.
import type { RobotsRecord } from "../crawl/v2/runner";
import type { SitemapDocRecord } from "../crawl/v2/discovery";
import type { DiscoverySource, UrlState } from "../crawl/v2/types";
import type { LanguageSnapshot, PageFacts, PageSnapshot, RobotsSnapshot } from "../snapshot/types";
import type { ProbeRecord } from "./probe-types";
import type { RenderResult } from "../render/pool";
import type { RenderedExtract } from "../render/run";

export type Category = "indexability" | "metadata" | "content" | "ai_search" | "links" | "international" | "images" | "structured_data" | "security" | "site" | "performance" | "accessibility";
export type Confidence = "verified" | "heuristic" | "advisory";
export type Need = "raw" | "rendered" | "headers" | "graph" | "lighthouse";

export interface Finding {
  ruleId: string;
  ruleVersion: number;
  /** The URL the finding is about (a page, robots.txt, a sitemap, llms.txt…). */
  url: string;
  confidence: Confidence;
  /**
   * "issue": the rule found the problem. "inconclusive": the rule could not judge this subject (its input was not
   * available, e.g. a probe skipped by robots.txt); evidence.code says why. Maps to SPEC's `inconclusive` finding state.
   */
  outcome: Outcome;
  message: string;
  evidence: Record<string, unknown>;
}

export type Outcome = "issue" | "inconclusive";
/** Machine-readable reasons a rule reports inconclusive. */
export type InconclusiveCode =
  | "probe_skipped_robots"
  | "low_confidence"
  // The crawl did not reach every URL, so a site-wide absence (zero inbound links) cannot be proven.
  | "partial_crawl"
  // A response that does not prove the resource is broken or fine (403, 429, 999, 5xx, timeout).
  | "ambiguous_status"
  // The server sent no Content-Length, so the size is unknown.
  | "size_unknown"
  // The page rendered, but the measurement did not complete (axe-core could not run, no metric was recorded).
  | "not_measured";

/** What a rule knows about the crawl as a whole. */
export interface CrawlView {
  id: string;
  origin: string;
  /** When the crawl started (ISO); "now" for rules that compare dates. */
  startedAt: string;
  /** Crawl settings that state user intent. */
  intent: { aiCrawlers: "allow" | "block" | null };
  robots: RobotsRecord | null;
  /** Is this URL allowed for this user-agent token by the stored robots.txt? null when robots.txt was not parsed. */
  robotsAllows(url: string, agent: string): boolean | null;
  sitemaps: SitemapDocRecord[];
  probes: ProbeRecord[];
  /** Pages the user marked as high-value (crawl setting keyPages, normalised); null when unset. */
  keyPages: string[] | null;
  /** True when no URL of the crawled host was left unfetched (budget, depth, failure, cancellation). */
  complete: boolean;
  /** Checked external links and images (resource phase), by URL. */
  resources: { links: Map<string, ResourceFacts>; images: Map<string, ResourceFacts> };
}

/** One external link or image the resource phase planned (resources table). */
export interface ResourceFacts {
  kind: "external_link" | "image";
  url: string;
  /** done: a response or a transport error was recorded; skipped: not requested (skipCode says why). */
  state: "queued" | "started" | "done" | "skipped";
  skipCode: string | null;
  method: string | null;
  status: number | null;
  contentType: string | null;
  /** Bytes, from Content-Length (or the total in Content-Range); null when the server sent neither. */
  contentLength: number | null;
  width: number | null;
  height: number | null;
  error: { code: string; message: string } | null;
  /** Pages that reference it, and the first few of them. */
  referrers: number;
  samplePages: string[];
}

/** hreflang annotation on a page: the language code as written and the resolved, normalised target. */
export interface Hreflang {
  lang: string;
  href: string;
}

/** A page's headless-browser render (page_renders): what "rendered" rules read. */
export interface PageRenderView {
  status: "rendered" | "timeout" | "error";
  error: string | null;
  finalUrl: string;
  elapsedMs: number;
  /** Lab data only (source "lab"). */
  metrics: RenderResult["metrics"];
  extract: RenderedExtract | null;
  requests: RenderResult["requests"];
  requestTotals: RenderResult["requestTotals"] | null;
  scriptLinks: RenderResult["scriptLinks"];
  scriptNavigations: string[];
  a11y: RenderResult["a11y"];
}

/** A fetched URL with its snapshot: what page rules read. Extraction fields are empty/null when `html` is false. */
export interface PageView extends Omit<PageSnapshot, "facts" | "robots" | "language"> {
  /** The response had an HTML body that was extracted. */
  html: boolean;
  facts: PageFacts | null;
  robots: RobotsSnapshot | null;
  language: LanguageSnapshot | null;
  urlId: number;
  /** Normalised URL (the finding subject). */
  url: string;
  state: UrlState;
  depth: number | null;
  discoveredVia: DiscoverySource[];
  /**
   * The page's render, when the audit rendered it. A rule that needs "rendered" is evaluated only on pages whose
   * render status is "rendered" (analyse.ts); elsewhere it does not run for the page.
   */
  render?: PageRenderView | null;
}

/** One crawl_urls row with the snapshot fields site rules compare across pages. */
export interface UrlFacts {
  id: number;
  url: string;
  state: UrlState;
  statusCode: number | null;
  redirectTarget: string | null;
  discoveredVia: DiscoverySource[];
  /** Present when the URL was fetched and returned an HTML body. */
  page: {
    noindex: boolean;
    /** First canonical in <head> or the Link header, resolved; body canonicals are ignored. */
    canonical: string | null;
    title: string | null;
    description: string | null;
    h1: string | null;
    textHash: string | null;
    simhash: string | null;
    template: string | null;
    wordCount: number;
    ogImage: string | null;
    icons: string[];
    hreflang: Hreflang[];
  } | null;
  /** Distinct crawled pages with an <a href> to this URL (self-links excluded). */
  inbound: number;
  /** Clicks from the start URL over <a href> links and redirects; null when unreachable. */
  linkDepth: number | null;
  /** Internal PageRank, 0–100 log-scaled (graph.ts); null for URLs outside the link graph. */
  pagerank: number | null;
}

export interface SiteView {
  urls: UrlFacts[];
  byUrl: Map<string, UrlFacts>;
}

export interface PageCtx {
  page: PageView;
  crawl: CrawlView;
  /** The compact view of every URL, for rules that judge a page's links by their targets. */
  site: SiteView;
}

export interface SiteCtx {
  site: SiteView;
  crawl: CrawlView;
  /** Page-rule issues per rule and template fingerprint: how many pages, and the first few (SITE-001). */
  pageIssues: Map<string, Map<string, { count: number; sample: string[] }>>;
}

/** What a history rule knows: this audit's results against the project's earlier audits (SITE-004, SITE-005). */
export interface HistoryCtx {
  crawl: Pick<CrawlView, "id" | "origin">;
  /** The project's latest earlier analysed audit. History rules run only when there is one. */
  previousAuditId: string;
  /** Occurrences of this audit whose state is regressed: resolved in an earlier audit, observed again here. */
  regressed: { ruleId: string; url: string; fingerprint: string }[];
  /** URLs this audit answered that no earlier audit's inventory had, with the rules of their Critical issue groups. */
  newUrls: { url: string; criticalRules: string[] }[];
}

export interface ResourceCtx {
  resource: ResourceFacts;
  crawl: CrawlView;
}

interface RuleBase<C> {
  id: string;
  /** Bump when logic changes; stored on every finding. */
  version: number;
  category: Category;
  confidence: Confidence;
  impact: 1 | 2 | 3 | 4 | 5;
  needs: Need[];
  /**
   * Page rules only: report one finding per template group and evidence.groupKey (e.g. a schema type) instead of one
   * per page, for defects a template repeats on every page it builds (group.ts).
   */
  groupByTemplate?: boolean;
  /**
   * What tells two findings of this rule about the same URL apart, for the finding's fingerprint (fingerprint.ts).
   * Default: evidence.groupKey, else "" (the rule reports at most one finding per URL). Never counts or samples.
   */
  evidenceKey?(f: Finding): string;
  evaluate(ctx: C): Finding[];
  explain: { why: string; fix: string; acceptance: string; docs?: string };
}

export type PageRule = RuleBase<PageCtx> & { scope: "page" };
export type SiteRule = RuleBase<SiteCtx> & { scope: "site" };
/**
 * Judges the audit against the project's history, after its issue states are written. Its findings are a summary of
 * other rules' results, so it is left out of the health score (those rules already count).
 */
export type HistoryRule = RuleBase<HistoryCtx> & { scope: "history" };
/** Judges one checked external link or image (resource phase); the finding's subject is the resource URL. */
export type ResourceRule = RuleBase<ResourceCtx> & { scope: "resource"; kind: ResourceFacts["kind"] };
export type Rule = PageRule | SiteRule | ResourceRule | HistoryRule;

/** Thrown by evaluate() when the rule cannot judge without a setting the user has not made. */
export class NeedsConfig extends Error {
  constructor(readonly setting: string) {
    super(`Needs the "${setting}" setting.`);
  }
}

/** A finding for `rule` about `url`. */
export function finding(rule: Pick<Rule, "id" | "version" | "confidence">, url: string, message: string, evidence: Record<string, unknown> = {}): Finding {
  return { ruleId: rule.id, ruleVersion: rule.version, url, confidence: rule.confidence, outcome: "issue", message, evidence };
}

/** The rule could not judge `url`; `code` says why. */
export function inconclusive(rule: Pick<Rule, "id" | "version" | "confidence">, url: string, code: InconclusiveCode, message: string, evidence: Record<string, unknown> = {}): Finding {
  return { ...finding(rule, url, message, { code, ...evidence }), outcome: "inconclusive" };
}

/** HTML 200 page that may be indexed: no noindex for all crawlers, and no canonical pointing elsewhere. */
export function isIndexable(u: UrlFacts): boolean {
  return u.statusCode === 200 && !!u.page && !u.page.noindex && (u.page.canonical === null || u.page.canonical === u.url);
}

export const inSitemap = (via: DiscoverySource[]) => via.includes("sitemap");
