import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "./run";

describe("SYSTEM_PROMPT", () => {
  it("ties rewrites to the business's real location and the page's language, and asks for nav and heading typos", () => {
    expect(SYSTEM_PROMPT).toMatch(/real location from "business"/);
    expect(SYSTEM_PROMPT).toMatch(/Never invent or guess a city/);
    expect(SYSTEM_PROMPT).toMatch(/in that page's language/);
    expect(SYSTEM_PROMPT).toMatch(/Arabic page gets an Arabic title/);
    expect(SYSTEM_PROMPT).toMatch(/nav label and heading for spelling mistakes/);
    expect(SYSTEM_PROMPT).toMatch(/grammar_or_typos/);
  });
});
