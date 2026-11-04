import { getAuditAi, requestAuditAi } from "@/lib/server/report";
import { route } from "../../../../_lib/handler";

/** The audit's AI analysis, if any, and whether its project has it on. */
export const GET = route<{ ws: string; id: string }>(async (_req, { ws, id }) => getAuditAi(ws, id));

/** Queue the AI analysis of a finished audit. A finished analysis is cached, so this cannot pay for one twice. */
export const POST = route<{ ws: string; id: string }>(async (_req, { ws, id }) => requestAuditAi(ws, id));
