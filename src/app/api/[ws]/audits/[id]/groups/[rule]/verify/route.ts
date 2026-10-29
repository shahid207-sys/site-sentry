import { getGroupVerification, verifyIssueGroup } from "@/lib/server/results";
import { assertLiveScans } from "@/lib/workspace";
import { rateLimit, route } from "../../../../../../_lib/handler";

/** Re-crawl only this issue group's URLs (and their redirect targets) and update their states. */
export const POST = route<{ ws: string; id: string; rule: string }>(async (req, { ws, id, rule }) => {
  rateLimit(req, `verify:${ws}`, 30, 60_000);
  assertLiveScans(ws);
  return verifyIssueGroup(ws, id, rule);
});

/** The group's latest verification and its per-URL results. */
export const GET = route<{ ws: string; id: string; rule: string }>(async (_req, { ws, id, rule }) => (await getGroupVerification(ws, id, rule)) ?? { verification: null });
