import { describe, expect, it } from "vitest";
import { cdnManagedReason } from "./cdn-paths";

describe("cdnManagedReason", () => {
  it("names the CDN for its injected paths", () => {
    expect(cdnManagedReason("/cdn-cgi/l/email-protection")).toMatch(/^Cloudflare-managed path \(\/cdn-cgi\/…\)/);
    expect(cdnManagedReason("/cdn-cgi/challenge-platform/scripts/jsd/main.js")).toMatch(/^Cloudflare/);
    expect(cdnManagedReason("/_vercel/insights/script.js")).toMatch(/^Vercel/);
    expect(cdnManagedReason("/akam/13/7a1b2c")).toMatch(/^Akamai/);
  });

  it("leaves the site's own paths alone, including look-alikes", () => {
    for (const p of ["/", "/cdn-cgi", "/cdn-cgi-docs", "/blog/cdn-cgi/l/email-protection", "/vercel/", "/akamai/"]) expect(cdnManagedReason(p), p).toBeNull();
  });
});
