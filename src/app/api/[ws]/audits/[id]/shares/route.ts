import { z } from "zod";
import { createAuditShare, listAuditShares } from "@/lib/server/report";
import { body, rateLimit, route } from "../../../../_lib/handler";

type P = { ws: string; id: string };

const Create = z.object({ password: z.string().max(200).nullable().optional(), expiresInDays: z.number().int().nullable().optional() });

/** A new read-only link to the audit's report. The token is in this response only. */
export const POST = route<P>(async (req, { ws, id }) => {
  rateLimit(req, `share-create:${ws}`, 20, 60_000);
  return createAuditShare(ws, id, await body(req, Create));
});

/** The audit's share links (never their tokens). */
export const GET = route<P>(async (_req, { ws, id }) => listAuditShares(ws, id));
