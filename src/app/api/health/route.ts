import { NextResponse } from "next/server";
import { connection } from "next/server";
import { getStore, liveScansEnabled } from "@/lib/workspace";

/** Liveness plus storage readability. Reveals no paths, versions or configuration values. */
export async function GET() {
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
  return NextResponse.json({ status: ok ? "ok" : "degraded", checks, liveScans: liveScansEnabled() }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
