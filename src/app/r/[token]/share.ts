import "server-only";
import type { NextRequest } from "next/server";
import { HttpError, rateLimit } from "@/app/api/_lib/handler";
import { SHARE_COOKIE, SHARE_HEADERS, type ShareRequest } from "@/lib/report/shares";
import { answerShare } from "@/lib/server/report";

/** Runs one share-link request; a refused or failed one still answers noindex and uncached. */
export async function shareRoute(req: NextRequest, token: string, want: ShareRequest["want"]): Promise<Response> {
  try {
    let password: string | undefined;
    if (req.method === "POST") {
      rateLimit(req, `share-password:${token}`, 10, 60_000, (s) => `Too many attempts. Wait ${s}s and try again.`);
      if (Number(req.headers.get("content-length") ?? 0) > 4096) throw new HttpError(413, "TOO_LARGE", "Request body is too large.");
      const form = await req.formData().catch(() => null);
      const v = form?.get("password");
      password = typeof v === "string" ? v : undefined;
    }
    const r = await answerShare(token, {
      method: req.method === "POST" ? "POST" : "GET",
      want,
      password,
      cookie: req.cookies.get(SHARE_COOKIE)?.value,
      secure: req.nextUrl.protocol === "https:",
    });
    return new Response(r.body || null, { status: r.status, headers: r.headers });
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error("[site-sentry] share link error:", (e as Error)?.message);
    return new Response(e instanceof HttpError ? e.message : "Something went wrong.", { status, headers: { ...SHARE_HEADERS, "content-type": "text/plain; charset=utf-8" } });
  }
}
