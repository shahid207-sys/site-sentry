import { auditSample, auditUrl } from "@/lib/audit/audit";
import { SafeFetchError, type SafeFetchErrorCode } from "@/lib/fetch/safe-fetch";

// Runs on the default Node.js runtime (needed for node:dns / node:net).

const STATUS: Record<SafeFetchErrorCode, number> = {
  INVALID_URL: 400,
  BLOCKED_HOST: 400,
  DNS_FAILED: 422,
  TIMEOUT: 504,
  TOO_MANY_REDIRECTS: 422,
  HTTP_ERROR: 422,
  NOT_HTML: 422,
  NETWORK: 502,
};

export async function POST(request: Request) {
  let body: { url?: unknown; sample?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: { code: "INVALID_URL", message: "Request body must be JSON." } }, { status: 400 });
  }

  if (body.sample === true) {
    return Response.json(auditSample());
  }

  if (typeof body.url !== "string") {
    return Response.json({ error: { code: "INVALID_URL", message: "Provide a url string." } }, { status: 400 });
  }

  try {
    return Response.json(await auditUrl(body.url));
  } catch (e) {
    if (e instanceof SafeFetchError) {
      return Response.json(
        { error: { code: e.code, message: e.message, httpStatus: e.httpStatus } },
        { status: STATUS[e.code] },
      );
    }
    console.error("audit failed", e);
    return Response.json({ error: { code: "INTERNAL", message: "Audit failed unexpectedly." } }, { status: 500 });
  }
}
