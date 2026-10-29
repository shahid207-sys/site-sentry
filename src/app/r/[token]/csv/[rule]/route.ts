import type { NextRequest } from "next/server";
import { shareRoute } from "../../share";

/** One issue group's full URL list, behind the same link, password and expiry as the report. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ token: string; rule: string }> }) {
  const { token, rule } = await ctx.params;
  return shareRoute(req, token, { csv: rule });
}
