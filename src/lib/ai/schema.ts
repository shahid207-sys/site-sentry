// The AI analyst's output (docs/SPEC.md "AI analysis"): strict JSON, validated with Zod before anything is stored.
// Every item carries citations; ground.ts drops what they do not support.
import { z } from "zod";

/** A finding ID (a rule ID with an issue group in this crawl), or a URL plus a quote of 25 words or fewer from its stored text. */
export const CitationSchema = z.object({
  findingId: z.string().nullable(),
  url: z.string().nullable(),
  quote: z.string().nullable(),
});
export type Citation = z.infer<typeof CitationSchema>;

const Point = z.object({ text: z.string(), citations: z.array(CitationSchema) });

export const QUALITY_KINDS = ["keyword_stuffing", "grammar_or_typos", "tone", "intent_mismatch", "brand_consistency"] as const;
export const STRATEGY_AREAS = ["architecture", "localisation", "doorway_page_risk"] as const;

export const AiOutputSchema = z.object({
  executiveSummary: z.object({ strengths: z.array(Point), weaknesses: z.array(Point) }),
  qualityIssues: z.array(z.object({ kind: z.enum(QUALITY_KINDS), url: z.string(), issue: z.string(), fix: z.string(), citations: z.array(CitationSchema) })),
  rewrites: z.array(z.object({ url: z.string(), title: z.string(), description: z.string(), h1: z.string(), citations: z.array(CitationSchema) })),
  strategy: z.array(z.object({ area: z.enum(STRATEGY_AREAS), text: z.string(), citations: z.array(CitationSchema) })),
  actionPlan: z.object({ thisWeek: z.array(Point), thisQuarter: z.array(Point) }),
});
export type AiOutput = z.infer<typeof AiOutputSchema>;

/** The validated output as stored: rewrites carry character counts computed here, never the model's. */
export type GroundedRewrite = AiOutput["rewrites"][number] & { titleChars: number; descriptionChars: number };
export type GroundedAnalysis = Omit<AiOutput, "rewrites"> & { rewrites: GroundedRewrite[] };

export interface DroppedCounts {
  /** Items removed because no valid citation was left, or because they made a banned claim. */
  items: number;
  /** Citations removed: unknown finding ID, URL without a quote, quote over 25 words or not in the stored text. */
  citations: number;
  /** Items removed for a claim about rankings, traffic or penalties (also counted in `items`). */
  bannedClaims: number;
  /** Items removed for quoting, in their own text, words that are not in the stored text (also counted in `items`). */
  unsupportedQuotes: number;
  /** Rewrites removed for not being in their page's detected language (also counted in `items`). */
  wrongLanguage: number;
}

export const AI_STATUSES = ["queued", "done", "failed", "not_configured", "over_budget"] as const;
export type AiStatus = (typeof AI_STATUSES)[number];

export interface StoredAiAnalysis {
  auditId: string;
  crawlId: string;
  status: AiStatus;
  model: string | null;
  analysis: GroundedAnalysis | null;
  dropped: DroppedCounts | null;
  usage: { inputTokens: number; outputTokens: number } | null;
  detail: string | null;
  updatedAt: string;
}
