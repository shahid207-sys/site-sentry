// The AiClient on the Gemini REST API (AI_PROVIDER=gemini, the default). Same job, prompt and validator as every other
// provider: the JSON schema here only shapes the answer, and run.ts still checks it with Zod and the grounding validator.
// The key goes in a header, never the URL, so it cannot reach a log through a request's address.
import { z } from "zod";
import type { AiClient } from "./run";
import { AiOutputSchema } from "./schema";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
/** Requests after the first, on 429 or 503. */
export const GEMINI_MAX_RETRIES = 5;
const BASE_WAIT_MS = 2_000;
/** A longer wait means a quota that will not come back soon (the free tier's daily limit): fail and say so. */
export const GEMINI_MAX_WAIT_MS = 120_000;
const REQUEST_TIMEOUT_MS = 300_000;

type Fetch = typeof globalThis.fetch;
export interface GeminiDeps {
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  log?: (event: string, data?: Record<string, unknown>) => void;
}

/** The server's wait, in ms: the Retry-After header, or Gemini's RetryInfo detail ("34s"). Null when it names none. */
export function serverWaitMs(headers: Pick<Headers, "get">, body: unknown): number | null {
  const header = Number(headers.get("retry-after"));
  if (Number.isFinite(header) && header > 0) return header * 1000;
  const details = (body as { error?: { details?: { "@type"?: string; retryDelay?: string }[] } } | null)?.error?.details;
  const delay = details?.find((d) => d["@type"]?.endsWith("RetryInfo"))?.retryDelay;
  const secs = delay ? Number.parseFloat(delay) : NaN;
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : null;
}

/** Gemini's finish reasons, in the terms run.ts acts on. */
function stopReason(finish: string | undefined, blocked: string | undefined): string | null {
  if (blocked) return "refusal";
  if (!finish) return null;
  if (finish === "STOP") return "end_turn";
  if (finish === "MAX_TOKENS") return "max_tokens";
  return ["SAFETY", "RECITATION", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "LANGUAGE", "OTHER"].includes(finish) ? "refusal" : finish.toLowerCase();
}

interface GenerateResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  modelVersion?: string;
}

export function geminiClient(apiKey: string, deps: GeminiDeps = {}): AiClient {
  const doFetch = deps.fetch ?? globalThis.fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const log = deps.log ?? (() => {});

  async function post<T>(model: string, method: string, body: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await doFetch(`${BASE}/${encodeURIComponent(model)}:${method}`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.ok) return (await res.json()) as T;
      const detail = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      const message = `Gemini ${method} answered HTTP ${res.status}: ${detail?.error?.message?.slice(0, 300) ?? res.statusText}`;
      if ((res.status !== 429 && res.status !== 503) || attempt >= GEMINI_MAX_RETRIES) throw new Error(message);
      const asked = serverWaitMs(res.headers, detail);
      if (asked !== null && asked > GEMINI_MAX_WAIT_MS) throw new Error(`${message} (it asks to wait ${Math.round(asked / 1000)} s)`);
      const wait = asked ?? Math.min(GEMINI_MAX_WAIT_MS, BASE_WAIT_MS * 2 ** attempt);
      log("ai.backoff", { status: res.status, waitMs: wait, attempt: attempt + 1 });
      await sleep(wait);
    }
  }

  const prompt = (model: string, system: string, user: string) => ({
    model: `models/${model}`,
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: "user", parts: [{ text: user }] }],
  });

  return {
    async countTokens({ model, system, user }) {
      const r = await post<{ totalTokens?: number }>(model, "countTokens", { generateContentRequest: prompt(model, system, user) });
      if (typeof r.totalTokens !== "number") throw new Error("Gemini countTokens returned no count");
      return r.totalTokens;
    },
    async complete({ model, system, user, maxTokens }) {
      const { model: _name, ...request } = prompt(model, system, user);
      const r = await post<GenerateResponse>(model, "generateContent", {
        ...request,
        generationConfig: { maxOutputTokens: maxTokens, responseMimeType: "application/json", responseJsonSchema: z.toJSONSchema(AiOutputSchema) },
      });
      const c = r.candidates?.[0];
      const text = (c?.content?.parts ?? []).flatMap((p) => (p.text && !p.thought ? [p.text] : [])).join("");
      const u = r.usageMetadata;
      return {
        text: text || null,
        stopReason: stopReason(c?.finishReason, r.promptFeedback?.blockReason),
        inputTokens: u?.promptTokenCount ?? 0,
        outputTokens: (u?.candidatesTokenCount ?? 0) + (u?.thoughtsTokenCount ?? 0),
        model: r.modelVersion ?? model,
      };
    },
  };
}
