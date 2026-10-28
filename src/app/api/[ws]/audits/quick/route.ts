import { z } from "zod";
import { HERO_PROFILE, HERO_RATE_LIMIT } from "@/lib/crawl/profiles";
import { summarize } from "@/lib/server/queries";
import { assertLiveScans, getStore } from "@/lib/workspace";
import { CATEGORY_IDS, launchAudit } from "../../../_lib/audits";
import { body, route } from "../../../_lib/handler";
import { limitByIp } from "../../../_lib/ip-limit";

// The public homepage form (docs/SPEC.md "Collaboration and accounts"): Quick profile only, every check category,
// and at most HERO_RATE_LIMIT.audits per client IP per hour across all web processes.

const Quick = z.object({ siteId: z.string().min(1).max(80), url: z.string().min(1).max(2000) });

export const POST = route<{ ws: string }>(async (req, { ws }) => {
  assertLiveScans(ws);
  await limitByIp(req, {
    key: `rl:hero-audit:${ws}`,
    limit: HERO_RATE_LIMIT.audits,
    windowMs: HERO_RATE_LIMIT.windowMs,
    message: (waitS) => `Free audits are limited to ${HERO_RATE_LIMIT.audits} an hour from one address. Try again in ${Math.max(1, Math.ceil(waitS / 60))} min.`,
  });
  const { siteId, url } = await body(req, Quick);
  const { audit, reused } = await launchAudit(ws, {
    siteId,
    mode: "single",
    urls: [url],
    profile: HERO_PROFILE,
    categories: CATEGORY_IDS,
    checkLinks: false,
    includeImportant: false,
  });
  return { audit: summarize(audit, await getStore(ws).read()), reused };
});
