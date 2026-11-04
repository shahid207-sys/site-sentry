// The CRAWLER_V2 flag on its own, with no imports: pages and the settings query read it without pulling in the
// queue (BullMQ) or database modules.
import type { Workspace } from "../../model";

/**
 * Crawler v2 runs every live-workspace audit. The legacy in-request engine is reachable only with an explicit
 * CRAWLER_V2=false. The sample workspace always uses its in-memory site.
 */
export function crawlerV2Enabled(ws: Workspace, env: Record<string, string | undefined> = process.env): boolean {
  return ws === "live" && env.CRAWLER_V2 !== "false";
}
