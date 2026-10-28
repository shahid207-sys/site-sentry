// The spec's rule contract (docs/SPEC.md "Rule engine and rule catalog"). Rules are pure: they read the stored
// snapshot (page rules) or a compact projection of the whole crawl (site rules), never the network or the clock.
import type { RobotsRecord } from "../crawl/v2/runner";
import type { SitemapDocRecord } from "../crawl/v2/discovery";
import type { DiscoverySource, UrlState } from "../crawl/v2/types";
import type { LanguageSnapshot, PageFacts, PageSnapshot, RobotsSnapshot } from "../snapshot/types";
import type { ProbeRecord } from "./probe-types";

export type Category = "indexability" | "metadata" | "content" | "ai_search";
export type Confidence = "verified" | "heuristic" | "advisory";
export type Need = "raw" | "rendered" | "headers" | "graph" | "lighthouse";

export interface Finding {
  ruleId: string;
  ruleVersion: number;
  /** The URL the finding is about (a page, robots.txt, a sitemap, llms.txt…). */
  url: string;
  confidence: Confidence;
  message: string;
  evidence: Record<string, unknown>;
}

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
  } | null;
}

export interface SiteView {
  urls: UrlFacts[];
  byUrl: Map<string, UrlFacts>;
}

export interface PageCtx {
  page: PageView;
  crawl: CrawlView;
}

export interface SiteCtx {
  site: SiteView;
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
  evaluate(ctx: C): Finding[];
  explain: { why: string; fix: string; acceptance: string; docs?: string };
}

export type PageRule = RuleBase<PageCtx> & { scope: "page" };
export type SiteRule = RuleBase<SiteCtx> & { scope: "site" };
export type Rule = PageRule | SiteRule;

/** Thrown by evaluate() when the rule cannot judge without a setting the user has not made. */
export class NeedsConfig extends Error {
  constructor(readonly setting: string) {
    super(`Needs the "${setting}" setting.`);
  }
}

/** A finding for `rule` about `url`. */
export function finding(rule: Pick<Rule, "id" | "version" | "confidence">, url: string, message: string, evidence: Record<string, unknown> = {}): Finding {
  return { ruleId: rule.id, ruleVersion: rule.version, url, confidence: rule.confidence, message, evidence };
}

/** HTML 200 page that may be indexed: no noindex for all crawlers, and no canonical pointing elsewhere. */
export function isIndexable(u: UrlFacts): boolean {
  return u.statusCode === 200 && !!u.page && !u.page.noindex && (u.page.canonical === null || u.page.canonical === u.url);
}

export const inSitemap = (via: DiscoverySource[]) => via.includes("sitemap");
