import type { Fetcher } from "../fetch/safe-fetch";
import type { Workspace } from "../model";
import type { Store } from "../store/store";

/** Everything a workflow function needs from the outside world, injected so tests are deterministic. */
export interface Deps {
  store: Store;
  fetch: Fetcher;
  now: () => Date;
  newId: () => string;
  source: Workspace;
  /** Wall-clock milliseconds, used only for step time budgets. */
  clockMs?: () => number;
}

export type WorkflowErrorCode = "NOT_FOUND" | "INVALID" | "CONFLICT" | "READ_ONLY" | "BUSY" | "LIVE_DISABLED";

export class WorkflowError extends Error {
  constructor(
    public code: WorkflowErrorCode,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}
