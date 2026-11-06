// The real AiClient, for the provider AI_PROVIDER names (gemini by default). The output is constrained to
// AiOutputSchema's JSON Schema; run.ts still validates the text with Zod, since that check, not the API, is what lets an
// answer be stored, and the same grounding validator judges every provider.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { geminiClient, type GeminiDeps } from "./gemini";
import type { AiClient } from "./run";
import { AiOutputSchema } from "./schema";

/** Models that take the server-side refusal fallback in its "default" form (Claude API). */
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

type Env = Record<string, string | undefined>;

const PROVIDERS = {
  gemini: { key: "GEMINI_API_KEY", model: "gemini-flash-latest" },
  anthropic: { key: "ANTHROPIC_API_KEY", model: "claude-sonnet-5-5" },
} as const;
export type AiProvider = keyof typeof PROVIDERS;

export function aiProvider(env: Env = process.env): AiProvider {
  const p = env.AI_PROVIDER?.trim().toLowerCase() || "gemini";
  if (p !== "gemini" && p !== "anthropic") throw new Error(`AI_PROVIDER must be gemini or anthropic, not "${env.AI_PROVIDER}"`);
  return p;
}
export const aiKeyName = (env: Env = process.env) => PROVIDERS[aiProvider(env)].key;
export const aiModel = (env: Env = process.env) => env.AI_ANALYSIS_MODEL || PROVIDERS[aiProvider(env)].model;

/** Null when the provider's API key is not set: the job then records `not_configured` and spends nothing. */
export function aiClientFromEnv(env: Env = process.env, deps: GeminiDeps = {}): AiClient | null {
  const key = env[aiKeyName(env)];
  if (!key) return null;
  return aiProvider(env) === "gemini" ? geminiClient(key, deps) : anthropicClient(key);
}

function anthropicClient(apiKey: string): AiClient {
  const client = new Anthropic({ apiKey });
  return {
    async countTokens({ model, system, user }) {
      const r = await client.messages.countTokens({ model, system, messages: [{ role: "user", content: user }] });
      return r.input_tokens;
    },
    async complete({ model, system, user, maxTokens }) {
      // Streaming, since a long answer can outlast the SDK's timeout for a plain request.
      const stream = client.beta.messages.stream({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: "user", content: user }],
        output_config: { format: betaZodOutputFormat(AiOutputSchema) },
        ...(FALLBACK_MODELS.test(model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
      });
      const m = await stream.finalMessage();
      const text = m.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return { text: text || null, stopReason: m.stop_reason, inputTokens: m.usage.input_tokens, outputTokens: m.usage.output_tokens, model: m.model };
    },
  };
}
