import { deleteCrawlFor, syncAudit } from "@/lib/crawl/v2/audit-bridge";
import { getDb } from "@/lib/db/client";
import { getAuditDetail } from "@/lib/server/queries";
import { deleteAudit } from "@/lib/workflow/audits";
import { getDeps, getStore } from "@/lib/workspace";
import { route } from "../../../_lib/handler";

export const GET = route<{ ws: string; id: string }>(async (_req, { ws, id }) => {
  // A v2 audit still marked running may have finished since the last sync: read its crawl first, so a finished audit
  // never shows as running or interrupted.
  const store = getStore(ws);
  const audit = (await store.read()).audits[id];
  if (audit?.crawler && audit.status === "running") await syncAudit(getDb(), store, id).catch(() => undefined);
  return getAuditDetail(ws, id);
});

export const DELETE = route<{ ws: string; id: string }>(async (_req, { ws, id }) => {
  const audit = (await getStore(ws).read()).audits[id];
  const out = await deleteAudit(id, await getDeps(ws));
  if (audit?.crawler) await deleteCrawlFor(getDb(), audit);
  return out;
});
