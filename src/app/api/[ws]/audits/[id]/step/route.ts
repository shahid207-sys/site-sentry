import { stepAudit } from "@/lib/crawl/engine";
import { syncAudit } from "@/lib/crawl/v2/audit-bridge";
import { getDb } from "@/lib/db/client";
import { summarize } from "@/lib/server/queries";
import { getDeps, getStore } from "@/lib/workspace";
import { rateLimit, route } from "../../../../_lib/handler";

/**
 * Advance a running audit by one bounded step. The progress view calls this repeatedly while it is open.
 * Crawler v2 audits are run by the worker process; for them this only reads progress from the crawls table.
 */
export const POST = route<{ ws: string; id: string }>(async (req, { ws, id }) => {
  rateLimit(req, `step:${id}`, 120, 60_000);
  const store = getStore(ws);
  if ((await store.read()).audits[id]?.crawler) {
    const audit = await syncAudit(getDb(), store, id);
    return { audit: summarize(audit, await store.read()), busy: true };
  }
  const { audit, busy } = await stepAudit(id, await getDeps(ws));
  return { audit: summarize(audit, await getStore(ws).read()), busy };
});
