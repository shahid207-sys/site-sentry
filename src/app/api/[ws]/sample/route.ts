import { z } from "zod";
import { getSettings } from "@/lib/server/queries";
import { getStore, resetSample } from "@/lib/workspace";
import { body, HttpError, route } from "../../_lib/handler";

const Put = z.union([z.object({ state: z.enum(["original", "current", "fixed", "offline"]) }), z.object({ reset: z.literal(true) })]);

/** Sample workspace only: switch which version of the simulated sites is "deployed", or restore the seed. */
export const PUT = route<{ ws: string }>(async (req, { ws }) => {
  if (ws !== "sample") throw new HttpError(404, "NOT_FOUND", "Only the sample workspace has a simulator.");
  const input = await body(req, Put);
  if ("reset" in input) await resetSample();
  else
    await getStore("sample").update((d) => {
      d.sampleState = input.state;
    });
  return getSettings("sample");
});
