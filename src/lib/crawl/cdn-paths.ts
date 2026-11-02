// Paths a CDN injects into or serves on the site's own host. They are not pages of the site: Cloudflare, for example,
// rewrites every e-mail address into a link to /cdn-cgi/l/email-protection#<hex> that a JavaScript decoder turns back
// into a mailto: link for visitors, and that answers 404 to a crawler. The crawl records such URLs as `cdn_managed`
// without fetching them, so link rules never call them broken (a real site: 381 pages, all false LNK-001).
// Prefixes only, matched against the URL path; each entry names the CDN for the reason shown on the URL.

export const CDN_PATH_PREFIXES: readonly { prefix: string; cdn: string }[] = [
  { prefix: "/cdn-cgi/", cdn: "Cloudflare" }, // email-protection, challenge-platform, trace, rum, scripts
  { prefix: "/_vercel/", cdn: "Vercel" }, // insights and speed-insights scripts
  { prefix: "/akam/", cdn: "Akamai" }, // Bot Manager sensor endpoints
];

/** The cdn_managed reason for a URL path, or null when the path is the site's own. */
export function cdnManagedReason(pathname: string): string | null {
  const hit = CDN_PATH_PREFIXES.find((c) => pathname.startsWith(c.prefix));
  return hit ? `${hit.cdn}-managed path (${hit.prefix}…): the CDN serves or rewrites it for visitors; it is not a page of the site and is not fetched.` : null;
}
