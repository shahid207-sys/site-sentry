import { getStore } from "@/lib/store/store";
import { defaultDeps, setExpectations } from "@/lib/workflow/service";
import { errorResponse, handleError, readJson } from "../_lib/respond";

/** Configure what the owner intends for a page: { pageUrl, canonicalUrl?, indexability? }. */
export async function PUT(request: Request) {
  const body = await readJson(request);
  if (typeof body?.pageUrl !== "string") return errorResponse("INVALID", "Provide pageUrl.", 400);
  try {
    const { pageUrl, ...rest } = body;
    return Response.json(await setExpectations(pageUrl, rest, defaultDeps(getStore())));
  } catch (e) {
    return handleError(e);
  }
}
