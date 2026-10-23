import { connection } from "next/server";
import { getStore } from "@/lib/store/store";
import { defaultDeps, listFindings, trackFinding } from "@/lib/workflow/service";
import { errorResponse, handleError, readJson } from "../_lib/respond";

export async function GET() {
  await connection(); // always read the store at request time
  try {
    return Response.json(await listFindings(defaultDeps(getStore())));
  } catch (e) {
    return handleError(e);
  }
}

/** Track a finding from a stored audit: { auditId, ruleCode }. */
export async function POST(request: Request) {
  const body = await readJson(request);
  if (typeof body?.auditId !== "string" || typeof body?.ruleCode !== "string") {
    return errorResponse("INVALID", "Provide auditId and ruleCode.", 400);
  }
  try {
    return Response.json(await trackFinding(body.auditId, body.ruleCode, defaultDeps(getStore())), { status: 201 });
  } catch (e) {
    return handleError(e);
  }
}
