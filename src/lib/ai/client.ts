// The real AiClient, on the Anthropic SDK. The output is constrained to AiOutputSchema's JSON Schema; run.ts still
// validates the text with Zod, since that check, not the API, is what lets an answer be stored.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { AiClient } from "./run";
import { AiOutputSchema } from "./schema";

/** Models that take the server-side refusal fallback in its "default" form (Claude API). */
const FALLBACK_MODELS = /^claude-(fable-5-1|opus-5-5|opus-5|sonnet-5-5)$/;

/** Null when no API key is set: the job then records `not_configured` and spends nothing. */
export function aiClientFromEnv(env: Record<string, string | undefined> = process.env): AiClient | null {
  if (!env.ANTHROPIC_API_KEY) return null;
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
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
