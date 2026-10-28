import { cancelAudit } from "@/lib/crawl/engine";
import { summarize } from "@/lib/server/queries";
import { getDeps, getStore } from "@/lib/workspace";
import { route } from "../../../../_lib/handler";

export const POST = route<{ ws: string; id: string }>(async (_req, { ws, id }) => {
  const audit = await cancelAudit(id, await getDeps(ws));
  return { audit: summarize(audit, await getStore(ws).read()) };
});
