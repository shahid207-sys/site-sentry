import { describe, expect, it } from "vitest";
import { botUserAgent, DEFAULT_BOT_NAME, resolveBotName, resolveBotUrl } from "./bot";

describe("crawler identity", () => {
  it("defaults to SiteSentryBot with no info URL (no domain we do not own)", () => {
    expect(resolveBotName({})).toBe(DEFAULT_BOT_NAME);
    expect(resolveBotUrl({})).toBeNull();
    expect(botUserAgent(DEFAULT_BOT_NAME, null)).toBe("SiteSentryBot/1.0");
  });

  it("uses the configured name and URL", () => {
    const name = resolveBotName({ CRAWLER_BOT_NAME: " AcmeAuditBot " });
    const url = resolveBotUrl({ CRAWLER_BOT_URL: "https://acme.example/bot" });
    expect(botUserAgent(name, url)).toBe("AcmeAuditBot/1.0 (+https://acme.example/bot)");
  });

  it("rejects names that are not robots.txt tokens, and unsafe URLs", () => {
    for (const bad of ["Acme Bot", "Acme/1.0", "1bot", "a;b", "x".repeat(41)]) expect(() => resolveBotName({ CRAWLER_BOT_NAME: bad })).toThrow(/product token/);
    for (const bad of ["not a url", "ftp://x.example/", "https://u:p@x.example/", "javascript:alert(1)", "https://x.example/a b"]) expect(() => resolveBotUrl({ CRAWLER_BOT_URL: bad })).toThrow(/CRAWLER_BOT_URL/);
  });
});
