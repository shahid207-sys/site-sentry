// What Site Sentry v1 actually checked. Audits imported from v1 recorded a rule as "pass" without
// saying which checks ran, and v1 had fewer checks than today's rules, so a v1 "pass" only covers these.
export const LEGACY_V1_NOTE = "Imported from Site Sentry v1, which checked a single page for title, canonical and indexability only.";

export const LEGACY_V1_CHECKS: Record<string, string[]> = {
  title: ["title/missing", "title/multiple", "title/empty", "title/too-long", "title/too-short"],
  canonical: ["canonical/expected-url"],
  indexability: ["indexability/unexpected-noindex", "indexability/missing-noindex"],
};
