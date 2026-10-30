import { getAuditPage } from "@/lib/server/results";
import { HttpError, route } from "../../../../_lib/handler";

/** One URL of a v2 audit (`?url=`, normalised): snapshot, links in and out, issues with their history. */
export const GET = route<{ ws: string; id: string }>(async (req, { ws, id }) => {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) throw new HttpError(400, "INVALID", "Pass the page as ?url=.");
  return getAuditPage(ws, id, url);
});
