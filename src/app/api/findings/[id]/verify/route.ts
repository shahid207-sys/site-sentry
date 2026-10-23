import { getStore } from "@/lib/store/store";
import { defaultDeps, verifyFinding } from "@/lib/workflow/service";
import { handleError } from "../../../_lib/respond";

/**
 * Re-scan the page and judge it against the finding's original acceptance criteria.
 * Takes no body: evidence always comes from a fresh server-side observation.
 */
export async function POST(_request: Request, ctx: RouteContext<"/api/findings/[id]/verify">) {
  const { id } = await ctx.params;
  try {
    return Response.json(await verifyFinding(id, defaultDeps(getStore())));
  } catch (e) {
    return handleError(e);
  }
}
