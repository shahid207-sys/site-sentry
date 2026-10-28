// The CRAWLER_V2 flag on its own, with no imports: pages and the settings query read it without pulling in the
// queue (BullMQ) or database modules.
import type { Workspace } from "../../model";

/** Crawler v2 runs live-workspace audits when CRAWLER_V2=true. The sample workspace always uses its in-memory site. */
export function crawlerV2Enabled(ws: Workspace, env: Record<string, string | undefined> = process.env): boolean {
  return ws === "live" && env.CRAWLER_V2 === "true";
}
