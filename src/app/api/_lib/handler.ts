import "server-only";
import { isIP } from "node:net";
import { NextResponse, type NextRequest } from "next/server";
import { ZodError, type ZodType } from "zod";
import type { Workspace } from "@/lib/model";
import { StoreUnavailableError } from "@/lib/store/store";
import { WorkflowError, type WorkflowErrorCode } from "@/lib/workflow/deps";
import { isWorkspace } from "@/lib/workspace";

const STATUS: Record<WorkflowErrorCode, number> = {
  NOT_FOUND: 404,
  INVALID: 400,
  CONFLICT: 409,
  READ_ONLY: 403,
  BUSY: 409,
  LIVE_DISABLED: 403,
};

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface ApiErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

function errorResponse(e: unknown): NextResponse<ApiErrorBody> {
  if (e instanceof WorkflowError) return NextResponse.json({ error: { code: e.code, message: e.message, details: e.details } }, { status: STATUS[e.code] });
  if (e instanceof HttpError) return NextResponse.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  if (e instanceof ZodError) {
    const first = e.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    return NextResponse.json({ error: { code: "INVALID", message: `${where}${first?.message ?? "Invalid request."}` } }, { status: 400 });
  }
  if (e instanceof StoreUnavailableError) {
    console.error("[site-sentry] store unavailable:", e.message);
    return NextResponse.json({ error: { code: "STORE_UNAVAILABLE", message: e.message } }, { status: 503 });
  }
  // Unexpected: log server-side, never return the stack.
  console.error("[site-sentry] unhandled API error:", (e as Error)?.message);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong on the server. Nothing was changed; try again." } }, { status: 500 });
}

type Ctx<P> = { params: Promise<P> };

/** Wrap a route handler: validates `ws`, maps domain errors to HTTP statuses, never leaks stacks. */
export function route<P extends { ws: string }>(fn: (req: NextRequest, p: Omit<P, "ws"> & { ws: Workspace }) => Promise<Response | unknown>) {
  return async (req: NextRequest, ctx: Ctx<P>) => {
    try {
      const params = await ctx.params;
      if (!isWorkspace(params.ws)) throw new HttpError(404, "NOT_FOUND", "Unknown workspace.");
      const out = await fn(req, params as Omit<P, "ws"> & { ws: Workspace });
      return out instanceof Response ? out : NextResponse.json(out ?? { ok: true });
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function body<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    const text = await req.text();
    if (text.length > 200_000) throw new HttpError(413, "TOO_LARGE", "Request body is too large.");
    raw = text ? JSON.parse(text) : {};
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, "INVALID", "Request body must be JSON.");
  }
  return schema.parse(raw);
}

// ---------- tiny in-memory rate limiter (per process; enough to stop accidental floods) ----------

const g = globalThis as unknown as { __ssRate?: Map<string, number[]> };
const buckets = (g.__ssRate ??= new Map<string, number[]>());

/** The header the trusted reverse proxy sets to the client's address (TRUSTED_PROXY_HEADER), lower-cased, or null. */
export function trustedProxyHeader(): string | null {
  return process.env.TRUSTED_PROXY_HEADER?.trim().toLowerCase() || null;
}

/**
 * The client's IP, read only from TRUSTED_PROXY_HEADER. Next route handlers cannot see the socket address, so without
 * that setting every forwarding header is ignored (a client can send any of them) and the address is unknown: null.
 * A list such as X-Forwarded-For gives the rightmost entry, the one the trusted proxy appended. Null also when the
 * header is missing or not an IP address.
 */
export function clientIp(req: NextRequest): string | null {
  const header = trustedProxyHeader();
  if (!header) return null;
  const ip = req.headers.get(header)?.split(",").at(-1)?.trim() ?? "";
  return isIP(ip) ? ip : null;
}

/**
 * In-process limiter. Keyed per client IP when TRUSTED_PROXY_HEADER gives one; otherwise all clients share one
 * bucket per key (the keys are already per workspace), which is stricter, never looser.
 */
export function rateLimit(req: NextRequest, key: string, limit: number, windowMs: number, message?: (waitS: number) => string) {
  const k = `${key}:${clientIp(req) ?? "shared"}`;
  const now = Date.now();
  const hits = (buckets.get(k) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    const waitS = Math.ceil((windowMs - (now - hits[0])) / 1000);
    throw new HttpError(429, "RATE_LIMITED", message?.(waitS) ?? `Too many requests. Wait ${waitS}s and try again.`);
  }
  hits.push(now);
  buckets.set(k, hits);
}
