// Every catalog rule the analysis job runs, in catalog order.
import { AIS_RULES } from "./ais";
import { CNT_RULES } from "./cnt";
import { EXPERT_RULES as X } from "./expert";
import type { Rule } from "./contract";
import { I18N_RULES } from "./i18n";
import { IDX_RULES } from "./idx";
import { IMG_RULES } from "./img";
import { LNK_RULES } from "./lnk";
import { META_RULES } from "./meta";
import { SD_RULES } from "./sd";
import { SEC_RULES } from "./sec";
import { PERF_RULES } from "./perf";
import { RENDERED_RULES as R } from "./rendered";
import { HISTORY_RULES, SITE_RULES } from "./site";

export const RULES: Rule[] = [
  ...IDX_RULES,
  ...R.IDX,
  ...X.IDX,
  ...META_RULES,
  ...X.META,
  ...CNT_RULES,
  ...X.CNT,
  ...AIS_RULES,
  ...R.AIS,
  ...LNK_RULES,
  ...R.LNK,
  ...X.LNK,
  ...I18N_RULES,
  ...X.I18N,
  ...IMG_RULES,
  ...R.IMG,
  ...SD_RULES,
  ...X.SD,
  ...SEC_RULES,
  ...PERF_RULES,
  ...R.PERF,
  ...R.A11Y,
  ...SITE_RULES,
  ...HISTORY_RULES,
];

/** Catalog IDs that are deliberately not implemented yet, with why. */
export const DEFERRED_RULES: Record<string, string> = {
  "CNT-013": "needs the keyword mapping UI (Phase 4)",
  "CNT-014": "needs the keyword mapping UI (Phase 4)",
  "PERF-002": "field data only (CrUX): needs a Google API key, not configured",
};

export const RULES_BY_ID = new Map(RULES.map((r) => [r.id, r]));
