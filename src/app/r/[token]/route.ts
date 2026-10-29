import type { NextRequest } from "next/server";
import { shareRoute } from "./share";

type Ctx = { params: Promise<{ token: string }> };

/** A read-only share link to an audit report (password form first when the link has one). */
export async function GET(req: NextRequest, ctx: Ctx) {
  return shareRoute(req, (await ctx.params).token, { report: true });
}

/** The password form posts here. */
export async function POST(req: NextRequest, ctx: Ctx) {
  return shareRoute(req, (await ctx.params).token, { report: true });
}
