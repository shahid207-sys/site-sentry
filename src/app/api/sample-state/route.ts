import { connection } from "next/server";
import { getStore } from "@/lib/store/store";
import { defaultDeps, setSampleState } from "@/lib/workflow/service";
import { handleError, readJson } from "../_lib/respond";

/** SAMPLE ONLY: the simulated state of the demo site. Has no effect on live findings. */
export async function GET() {
  await connection();
  const { sampleState } = await getStore().read();
  return Response.json({ state: sampleState });
}

export async function PUT(request: Request) {
  const body = await readJson(request);
  try {
    return Response.json({ state: await setSampleState(body?.state, defaultDeps(getStore())) });
  } catch (e) {
    return handleError(e);
  }
}
