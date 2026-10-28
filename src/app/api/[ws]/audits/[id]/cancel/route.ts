import { cancelAudit } from "@/lib/crawl/engine";
import { controlCrawl, getCrawlQueue, syncAudit } from "@/lib/crawl/v2/audit-bridge";
import { getDb } from "@/lib/db/client";
import { summarize } from "@/lib/server/queries";
import { getDeps, getStore } from "@/lib/workspace";
import { route } from "../../../../_lib/handler";

export const POST = route<{ ws: string; id: string }>(async (_req, { ws, id }) => {
  const store = getStore(ws);
  const v2 = (await store.read()).audits[id];
  if (v2?.crawler) {
    // Crawler v2: the worker sees `cancelling` before its next request and finalises every URL as cancelled.
    await controlCrawl(getDb(), getCrawlQueue(), v2, "cancel");
    return { audit: summarize(await syncAudit(getDb(), store, id), await store.read()) };
  }
  const audit = await cancelAudit(id, await getDeps(ws));
  return { audit: summarize(audit, await getStore(ws).read()) };
});
