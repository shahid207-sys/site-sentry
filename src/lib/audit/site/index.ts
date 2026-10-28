import { robotsRule, sitemapRule } from "./crawl-files";
import { duplicatesRule } from "./duplicates";
import { brokenImageRule, linksRule } from "./links";
import type { SiteRule } from "./types";

/** Registry of cross-page rules, run once per audit over all snapshots. */
export const SITE_RULES: SiteRule[] = [robotsRule, sitemapRule, linksRule, brokenImageRule, duplicatesRule];

export function siteRuleById(id: string): SiteRule | undefined {
  return SITE_RULES.find((r) => r.id === id);
}
