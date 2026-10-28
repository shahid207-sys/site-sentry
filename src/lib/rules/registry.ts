// Every catalog rule the analysis job runs, in catalog order.
import { AIS_RULES } from "./ais";
import { CNT_RULES } from "./cnt";
import type { Rule } from "./contract";
import { IDX_RULES } from "./idx";
import { META_RULES } from "./meta";

export const RULES: Rule[] = [...IDX_RULES, ...META_RULES, ...CNT_RULES, ...AIS_RULES];

/** Catalog IDs that are deliberately not implemented yet, with why. */
export const DEFERRED_RULES: Record<string, string> = {
  "IDX-018": "needs rendered HTML (Phase 5 renderer)",
};

export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));
