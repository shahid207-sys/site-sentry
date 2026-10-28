import { stepAudit } from "@/lib/crawl/engine";
import { summarize } from "@/lib/server/queries";
import { getDeps, getStore } from "@/lib/workspace";
import { rateLimit, route } from "../../../../_lib/handler";

/** Advance a running audit by one bounded step. The progress view calls this repeatedly while it is open. */
export const POST = route<{ ws: string; id: string }>(async (req, { ws, id }) => {
  rateLimit(req, `step:${id}`, 120, 60_000);
  const { audit, busy } = await stepAudit(id, await getDeps(ws));
  return { audit: summarize(audit, await getStore(ws).read()), busy };
});
