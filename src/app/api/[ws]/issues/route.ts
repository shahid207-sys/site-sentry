import { listIssues } from "@/lib/server/queries";
import { route } from "../../_lib/handler";

export const GET = route<{ ws: string }>(async (req, { ws }) => listIssues(ws, req.nextUrl.searchParams.get("site") ?? undefined));
