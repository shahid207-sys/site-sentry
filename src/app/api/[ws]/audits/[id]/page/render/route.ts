import { getAuditPageRender } from "@/lib/server/results";
import { HttpError, route } from "../../../../../_lib/handler";

/** One URL's render in a v2 audit (`?url=`, normalised): raw vs rendered, lab metrics, requests, axe-core; `&html=1` adds both documents. */
export const GET = route<{ ws: string; id: string }>(async (req, { ws, id }) => {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) throw new HttpError(400, "INVALID", "Pass the page as ?url=.");
  return getAuditPageRender(ws, id, url, req.nextUrl.searchParams.get("html") === "1");
});
