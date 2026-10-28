import { controlCrawl, getCrawlQueue, syncAudit } from "@/lib/crawl/v2/audit-bridge";
import { getDb } from "@/lib/db/client";
import { summarize } from "@/lib/server/queries";
import { WorkflowError } from "@/lib/workflow/deps";
import { getStore } from "@/lib/workspace";
import { route } from "../../../../_lib/handler";

/** Crawler v2 only: pause the audit's crawl through crawls.status. */
export const POST = route<{ ws: string; id: string }>(async (_req, { ws, id }) => {
  const store = getStore(ws);
  const audit = (await store.read()).audits[id];
  if (!audit) throw new WorkflowError("NOT_FOUND", "Audit not found.");
  await controlCrawl(getDb(), getCrawlQueue(), audit, "pause");
  return { audit: summarize(await syncAudit(getDb(), store, id), await store.read()) };
});
