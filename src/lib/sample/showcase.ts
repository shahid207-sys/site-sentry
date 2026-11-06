// The public sample audit and the homepage preview card: Northwind Outdoor, as the crawler v2 engine audited it.
// v2-sample.json is written by scripts/sample-v2.ts (npm run sample:v2) from two real audits of the fixture
// site in fixtures/sample-v2, so every title, count and piece of evidence here is engine output.
import type { Priority } from "../results/priority";
import type { ReportGroup } from "../results/report";
import snapshot from "./v2-sample.json";
import type { SampleV2Snapshot } from "./v2-types";

const SAMPLE = snapshot as unknown as SampleV2Snapshot;

export type ShowcaseGroup = ReportGroup;

export interface SampleShowcase {
  siteName: string;
  origin: string;
  auditedAt: string;
  profile: string;
  /** URL budget of the profile the audit ran with (Standard). */
  budget: number | null;
  /** Pages the crawl fetched and analysed. */
  pagesInspected: number;
  coveragePercent: number;
  health: number | null;
  /** Issue groups per priority. */
  priorities: Record<Priority, number>;
  rulesRan: number;
  /** Highest priority score first. */
  groups: ShowcaseGroup[];
  comparison: SampleV2Snapshot["comparison"];
  /** One point per audit, oldest first. */
  history: { at: string; health: number }[];
}

export function getSampleShowcase(): SampleShowcase {
  const o = SAMPLE.overview;
  return {
    siteName: SAMPLE.siteName,
    origin: SAMPLE.origin,
    auditedAt: o.createdAt,
    profile: o.profile,
    budget: SAMPLE.crawl.budget,
    pagesInspected: o.coverage.answered,
    coveragePercent: o.coverage.percent ?? 0,
    health: o.health?.score ?? null,
    priorities: o.priorities,
    rulesRan: SAMPLE.rulesRan,
    groups: SAMPLE.groups,
    comparison: SAMPLE.comparison,
    history: SAMPLE.history.filter((h): h is { at: string; health: number } => h.health !== null),
  };
}

/** The URL's path on the sample site, or the whole URL when it is elsewhere. */
export const samplePath = (url: string, origin: string) => (url.startsWith(origin) ? url.slice(origin.length) || "/" : url);
