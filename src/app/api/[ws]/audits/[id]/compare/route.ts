import { getComparison } from "@/lib/server/queries";
import { route } from "../../../../_lib/handler";

export const GET = route<{ ws: string; id: string }>(async (req, { ws, id }) => getComparison(ws, id, req.nextUrl.searchParams.get("base") ?? undefined));
