import { getIssue } from "@/lib/server/queries";
import { HttpError, route } from "../../../_lib/handler";

export const GET = route<{ ws: string; fp: string }>(async (req, { ws, fp }) => {
  const site = req.nextUrl.searchParams.get("site");
  if (!site) throw new HttpError(400, "INVALID", "site is required.");
  return getIssue(ws, site, decodeURIComponent(fp));
});
