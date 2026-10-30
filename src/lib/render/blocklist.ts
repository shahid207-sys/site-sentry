// Ads and analytics hosts a rendered page may not load (docs/SPEC.md Phase 5: "ads/analytics blocked"). They change
// nothing an audit judges, cost time and bytes, and would record a visit on the site owner's analytics. A request to
// one of these hosts or any subdomain of it is aborted and logged as blocked.
export const BLOCKED_HOSTS = [
  // Google ads and analytics
  "google-analytics.com",
  "googletagmanager.com",
  "googleadservices.com",
  "googlesyndication.com",
  "doubleclick.net",
  "adservice.google.com",
  "analytics.google.com",
  // Social pixels
  "connect.facebook.net",
  "analytics.tiktok.com",
  "ads-twitter.com",
  "analytics.twitter.com",
  "px.ads.linkedin.com",
  "snap.licdn.com",
  "bat.bing.com",
  "ct.pinterest.com",
  // Product analytics and session replay
  "hotjar.com",
  "clarity.ms",
  "segment.com",
  "segment.io",
  "mixpanel.com",
  "amplitude.com",
  "heap.io",
  "heapanalytics.com",
  "fullstory.com",
  "mouseflow.com",
  "plausible.io",
  "nr-data.net",
  // Ad networks and measurement
  "amazon-adsystem.com",
  "adnxs.com",
  "criteo.com",
  "criteo.net",
  "taboola.com",
  "outbrain.com",
  "scorecardresearch.com",
  "quantserve.com",
  "moatads.com",
  "rubiconproject.com",
  "pubmatic.com",
  "casalemedia.com",
  "adsrvr.org",
] as const;

/** True when `host` is a blocked host or a subdomain of one. */
export function isBlockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  return BLOCKED_HOSTS.some((d) => h === d || h.endsWith(`.${d}`));
}
