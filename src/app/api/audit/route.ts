import { getStore } from "@/lib/store/store";
import { defaultDeps, runAudit } from "@/lib/workflow/service";
import { errorResponse, handleError, readJson } from "../_lib/respond";

// Runs on the default Node.js runtime (needed for node:dns / node:net / node:fs).

export async function POST(request: Request) {
  const body = await readJson(request);
  if (!body) return errorResponse("INVALID_URL", "Request body must be JSON.", 400);

  const input = body.sample === true ? { sample: true as const } : typeof body.url === "string" ? { url: body.url } : null;
  if (!input) return errorResponse("INVALID_URL", "Provide a url string.", 400);

  try {
    return Response.json(await runAudit(input, defaultDeps(getStore())));
  } catch (e) {
    return handleError(e);
  }
}
