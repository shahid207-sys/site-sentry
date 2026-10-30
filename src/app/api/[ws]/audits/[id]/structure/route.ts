import { getAuditStructure } from "@/lib/server/results";
import { route } from "../../../../_lib/handler";

/** Crawl depth histogram and duplicate clusters of a v2 audit (Architecture and Content screens). */
export const GET = route<{ ws: string; id: string }>(async (_req, { ws, id }) => getAuditStructure(ws, id));
