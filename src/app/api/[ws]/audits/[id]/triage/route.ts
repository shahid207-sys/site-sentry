import { z } from "zod";
import { TRIAGE_STATUSES } from "@/lib/db/schema";
import { getAuditTriage, updateAuditTriage } from "@/lib/server/results";
import { body, rateLimit, route } from "../../../../_lib/handler";

type P = { ws: string; id: string };

const Update = z.object({
  subjects: z.array(z.string().min(1).max(200)).min(1).max(5000),
  status: z.enum(TRIAGE_STATUSES),
  assignee: z.string().max(120).nullable().optional(),
  note: z.string().max(2000).nullable().optional(),
});

/** Fix board columns per issue group and per-issue calls (fixed, ignored with a reason) of a v2 audit's project. */
export const GET = route<P>(async (_req, { ws, id }) => getAuditTriage(ws, id));

/** Move issue groups ("rule:<id>") between board columns, or mark issues ("fp:<fingerprint>") fixed or ignored. */
export const POST = route<P>(async (req, { ws, id }) => {
  rateLimit(req, `triage:${ws}`, 120, 60_000);
  const { subjects, ...change } = await body(req, Update);
  return updateAuditTriage(ws, id, subjects, change);
});
