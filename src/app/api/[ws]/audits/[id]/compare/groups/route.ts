import { getGroupComparison } from "@/lib/server/results";
import { route } from "../../../../../_lib/handler";

/** Issue groups that are new, persistent, resolved, regressed or not re-checked since `?base=` (default: the previous analysed audit). */
export const GET = route<{ ws: string; id: string }>(async (req, { ws, id }) => getGroupComparison(ws, id, req.nextUrl.searchParams.get("base") ?? undefined));
