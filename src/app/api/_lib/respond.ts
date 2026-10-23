import { SafeFetchError, type SafeFetchErrorCode } from "@/lib/fetch/safe-fetch";
import { WorkflowError } from "@/lib/workflow/service";

const FETCH_STATUS: Record<SafeFetchErrorCode, number> = {
  INVALID_URL: 400,
  BLOCKED_HOST: 400,
  DNS_FAILED: 422,
  TIMEOUT: 504,
  TOO_MANY_REDIRECTS: 422,
  HTTP_ERROR: 422,
  NOT_HTML: 422,
  NETWORK: 502,
};

export function errorResponse(code: string, message: string, status: number, extra?: object) {
  return Response.json({ error: { code, message, ...extra } }, { status });
}

/** Map known errors to JSON responses. Failures are always errors, never empty results. */
export function handleError(e: unknown) {
  if (e instanceof SafeFetchError) {
    return errorResponse(e.code, e.message, FETCH_STATUS[e.code], { httpStatus: e.httpStatus });
  }
  if (e instanceof WorkflowError) {
    return errorResponse(e.code, e.message, e.code === "NOT_FOUND" ? 404 : 400);
  }
  console.error(e);
  return errorResponse("INTERNAL", "Something went wrong.", 500);
}

export async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" ? body : null;
  } catch {
    return null;
  }
}
