import { getOverview } from "@/lib/server/queries";
import { route } from "../../_lib/handler";

export const GET = route<{ ws: string }>(async (_req, { ws }) => getOverview(ws));
