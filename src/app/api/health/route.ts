import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, connection, type NextRequest } from "next/server";
import { getStore, liveScansEnabled } from "@/lib/workspace";
import { clientAddressProblem } from "../_lib/ip-limit";

/** True when the request carries `Authorization: Bearer <ADMIN_TOKEN>`. Never true while ADMIN_TOKEN is unset. */
function isAdmin(req: NextRequest): boolean {
  const token = process.env.ADMIN_TOKEN?.trim();
  if (!token) return false;
  const sent = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim();
  if (!sent) return false;
  const digest = (s: string) => createHash("sha256").update(s).digest(); // equal lengths for the constant-time compare
  return timingSafeEqual(digest(sent), digest(token));
}

/**
 * Liveness plus storage readability. Reveals no paths, versions or configuration values. An admin (ADMIN_TOKEN as a
 * bearer token) also gets `admin.quickAudit`: whether the homepage quick audit can identify clients, and if not, why.
 */
export async function GET(req: NextRequest) {
  await connection();
  const checks: Record<string, "ok" | "error"> = {};
  for (const ws of ["live", "sample"] as const) {
    try {
      await getStore(ws).read();
      checks[`store_${ws}`] = "ok";
    } catch {
      checks[`store_${ws}`] = "error";
    }
  }
  const ok = Object.values(checks).every((v) => v === "ok");
  const body: Record<string, unknown> = { status: ok ? "ok" : "degraded", checks, liveScans: liveScansEnabled() };
  if (isAdmin(req)) {
    const problem = clientAddressProblem();
    body.admin = { quickAudit: problem ? { clientAddress: "unavailable", reason: problem } : { clientAddress: "configured" } };
  }
  return NextResponse.json(body, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
