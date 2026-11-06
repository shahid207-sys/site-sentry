import { describe, expect, it } from "vitest";
import { aiClientFromEnv, aiKeyName, aiModel, aiProvider } from "./client";
import { GEMINI_MAX_RETRIES, geminiClient, serverWaitMs } from "./gemini";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers });
const OK = { candidates: [{ content: { parts: [{ text: "ignored", thought: true }, { text: '{"a":1}' }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 2 }, modelVersion: "gemini-x" };
const req = { model: "gemini-x", system: "s", user: "u", maxTokens: 100 };

function fake(...answers: Response[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const waits: number[] = [];
  const client = geminiClient("KEY", {
    fetch: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return answers.shift() ?? json(500, {});
    }) as typeof fetch,
    sleep: async (ms) => void waits.push(ms),
  });
  return { client, calls, waits };
}

describe("geminiClient", () => {
  it("sends the key in a header, asks for JSON, and leaves thoughts out of the text", async () => {
    const f = fake(json(200, OK));
    expect(await f.client.complete(req)).toEqual({ text: '{"a":1}', stopReason: "end_turn", inputTokens: 10, outputTokens: 7, model: "gemini-x" });
    expect(f.calls[0].url).not.toContain("KEY");
    expect((f.calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("KEY");
    const body = JSON.parse(f.calls[0].init.body as string);
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig.responseJsonSchema.properties).toHaveProperty("executiveSummary");
  });

  it("backs off on 429 and 503, by the server's wait when it names one", async () => {
    const f = fake(
      json(429, { error: { message: "slow", details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" }] } }),
      json(503, { error: { message: "busy" } }),
      json(429, {}, { "retry-after": "3" }),
      json(200, OK),
    );
    expect((await f.client.complete(req)).text).toBe('{"a":1}');
    expect(f.waits).toEqual([7000, 4000, 3000]);
  });

  it("gives up after its retries, and at once on a wait over the cap or another error", async () => {
    const many = fake(...Array.from({ length: GEMINI_MAX_RETRIES + 2 }, () => json(429, {})));
    await expect(many.client.complete(req)).rejects.toThrow("HTTP 429");
    expect(many.calls).toHaveLength(GEMINI_MAX_RETRIES + 1);
    const daily = fake(json(429, { error: { message: "quota", details: [{ "@type": "x.RetryInfo", retryDelay: "3600s" }] } }));
    await expect(daily.client.complete(req)).rejects.toThrow("wait 3600 s");
    expect(daily.waits).toEqual([]);
    const bad = fake(json(400, { error: { message: "bad schema" } }));
    await expect(bad.client.complete(req)).rejects.toThrow("bad schema");
    expect(bad.calls).toHaveLength(1);
  });

  it("maps a cut-off answer and a blocked prompt to what the job acts on", async () => {
    expect((await fake(json(200, { candidates: [{ finishReason: "MAX_TOKENS" }] })).client.complete(req)).stopReason).toBe("max_tokens");
    expect((await fake(json(200, { candidates: [{ finishReason: "SAFETY" }] })).client.complete(req)).stopReason).toBe("refusal");
    expect((await fake(json(200, { promptFeedback: { blockReason: "OTHER" } })).client.complete(req)).stopReason).toBe("refusal");
  });

  it("counts tokens with the system prompt included", async () => {
    const f = fake(json(200, { totalTokens: 42 }));
    expect(await f.client.countTokens(req)).toBe(42);
    expect(JSON.parse(f.calls[0].init.body as string).generateContentRequest.systemInstruction.parts[0].text).toBe("s");
  });

  it("reads no wait from a response that names none", () => {
    expect(serverWaitMs(new Headers(), { error: {} })).toBeNull();
  });
});

describe("the provider setting", () => {
  it("defaults to Gemini, and each provider has its own key and default model", () => {
    expect(aiProvider({})).toBe("gemini");
    expect(aiKeyName({})).toBe("GEMINI_API_KEY");
    expect(aiKeyName({ AI_PROVIDER: "anthropic" })).toBe("ANTHROPIC_API_KEY");
    expect(aiModel({ AI_PROVIDER: "anthropic" })).toBe("claude-sonnet-5-5");
    expect(aiModel({ AI_ANALYSIS_MODEL: "custom" })).toBe("custom");
    expect(() => aiProvider({ AI_PROVIDER: "other" })).toThrow("AI_PROVIDER");
  });

  it("makes no client without the chosen provider's key", () => {
    expect(aiClientFromEnv({ ANTHROPIC_API_KEY: "x" })).toBeNull();
    expect(aiClientFromEnv({ AI_PROVIDER: "anthropic", GEMINI_API_KEY: "x" })).toBeNull();
    expect(aiClientFromEnv({ GEMINI_API_KEY: "x" })).not.toBeNull();
    expect(aiClientFromEnv({ AI_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "x" })).not.toBeNull();
  });
});
