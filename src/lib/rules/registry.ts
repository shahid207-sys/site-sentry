// Every catalog rule the analysis job runs, in catalog order.
import { AIS_RULES } from "./ais";
import { CNT_RULES } from "./cnt";
import type { Rule } from "./contract";
import { I18N_RULES } from "./i18n";
import { IDX_RULES } from "./idx";
import { IMG_RULES } from "./img";
import { LNK_RULES } from "./lnk";
import { META_RULES } from "./meta";
import { SD_RULES } from "./sd";
import { SEC_RULES } from "./sec";
import { SITE_RULES } from "./site";

export const RULES: Rule[] = [...IDX_RULES, ...META_RULES, ...CNT_RULES, ...AIS_RULES, ...LNK_RULES, ...I18N_RULES, ...IMG_RULES, ...SD_RULES, ...SEC_RULES, ...SITE_RULES];

/** Catalog IDs that are deliberately not implemented yet, with why. */
export const DEFERRED_RULES: Record<string, string> = {
  "IDX-018": "needs rendered HTML (Phase 5 renderer)",
  "CNT-013": "needs the keyword mapping UI (Phase 4)",
  "CNT-014": "needs the keyword mapping UI (Phase 4)",
  "AIS-004": "needs rendered HTML (Phase 5 renderer)",
  "LNK-009": "needs rendered HTML to prove a link exists only as a JS handler (Phase 5 renderer)",
  "IMG-009": "needs the LCP element (Phase 5 renderer)",
  "SITE-004": "needs audit history (Phase 3)",
  "SITE-005": "needs audit history (Phase 3)",
  "PERF-*": "needs Lighthouse / field data (Phase 5)",
  "A11Y-*": "needs rendered DOM checks (Phase 5)",
};

export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));
