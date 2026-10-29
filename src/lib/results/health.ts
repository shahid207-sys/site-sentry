// Health score (docs/HEALTH-SCORE.md "Health score"): 0–100 over the rules that ran in a crawl, by category.
import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { Category, Confidence, Rule } from "../rules/contract";
import { crawlCoverage } from "./coverage";
import { CONFIDENCE_WEIGHT } from "./priority";

type Exec = Pick<Db, "execute">;

/** Published category weights (sum 100). */
export const CATEGORY_WEIGHTS: Record<Category, number> = {
  indexability: 25,
  content: 15,
  metadata: 12,
  links: 12,
  structured_data: 8,
  images: 8,
  international: 6,
  security: 6,
  ai_search: 4,
  site: 4,
};

/** Below this coverage (percent of eligible URLs answered) the score is stored flagged partial_coverage. */
export const PARTIAL_COVERAGE_BELOW = 50;

export interface RuleResult {
  ruleId: string;
  category: Category;
  impact: number;
  confidence: Confidence;
  /** The rule's issue group priority score, 0 when it found nothing. */
  score: number;
}

export interface CategoryHealth {
  weight: number;
  rulesRan: number;
  /** Σ group score over the category's rules that ran. */
  deduction: number;
  /** Σ impact × confidence weight over the same rules: the deduction if every one hit every indexable page. */
  maximum: number;
  /** 100 × (1 − deduction / maximum), one decimal. */
  score: number;
}

export interface Health {
  /** Weighted mean of the category scores over categories with a rule that ran, one decimal; null when none ran. */
  score: number | null;
  partialCoverage: boolean;
  coveragePercent: number | null;
  categories: Partial<Record<Category, CategoryHealth>>;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function healthScore(ran: RuleResult[], coveragePercent: number | null): Health {
  const categories: Health["categories"] = {};
  for (const r of ran) {
    const c = (categories[r.category] ??= { weight: CATEGORY_WEIGHTS[r.category], rulesRan: 0, deduction: 0, maximum: 0, score: 0 });
    c.rulesRan++;
    c.deduction += r.score;
    c.maximum += r.impact * CONFIDENCE_WEIGHT[r.confidence];
  }
  let weighted = 0;
  let weights = 0;
  for (const c of Object.values(categories)) {
    c.score = c.maximum ? round1(100 * (1 - Math.min(c.deduction, c.maximum) / c.maximum)) : 100;
    c.deduction = Math.round(c.deduction * 10000) / 10000;
    c.maximum = Math.round(c.maximum * 10000) / 10000;
    weighted += c.weight * c.score;
    weights += c.weight;
  }
  return {
    score: weights ? round1(weighted / weights) : null,
    partialCoverage: coveragePercent === null || coveragePercent < PARTIAL_COVERAGE_BELOW,
    coveragePercent,
    categories,
  };
}

/** Computes and stores crawls.health from rule_runs (status 'ran') and the crawl's issue groups. */
export async function writeHealth(db: Exec, crawlId: string, rules: Rule[]): Promise<Health> {
  const byId = new Map(rules.map((r) => [r.id, r]));
  const r = await db.execute(sql`select rr.rule_id, coalesce(g.score, 0)::float8 as score from rule_runs rr
    left join issue_groups g on g.crawl_id = rr.crawl_id and g.rule_id = rr.rule_id
    where rr.crawl_id = ${crawlId}::uuid and rr.status = 'ran'`);
  const ran = (r.rows as { rule_id: string; score: number }[]).flatMap((x) => {
    const rule = byId.get(x.rule_id);
    return rule ? [{ ruleId: rule.id, category: rule.category, impact: rule.impact, confidence: rule.confidence, score: Number(x.score) }] : [];
  });
  const health = healthScore(ran, (await crawlCoverage(db, crawlId)).percent);
  await db.execute(sql`update crawls set health = ${JSON.stringify(health)}::jsonb where id = ${crawlId}::uuid`);
  return health;
}
