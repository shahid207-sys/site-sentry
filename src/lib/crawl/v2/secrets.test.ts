import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { crawlSecretScope, decryptSecret, encryptSecret, secretKey } from "./secrets";

const key = randomBytes(32);

describe("crawl secrets", () => {
  it("round-trips, and the token does not contain the plaintext", () => {
    const token = encryptSecret("hunter2-staging", key, crawlSecretScope("c1"));
    expect(token).toMatch(/^v1\./);
    expect(token).not.toContain("hunter2");
    expect(decryptSecret(token, key, crawlSecretScope("c1"))).toBe("hunter2-staging");
    expect(encryptSecret("same", key, "s")).not.toBe(encryptSecret("same", key, "s")); // random IV
  });

  it("does not decrypt for another crawl, another key, or after tampering", () => {
    const token = encryptSecret("pw", key, crawlSecretScope("c1"));
    expect(() => decryptSecret(token, key, crawlSecretScope("c2"))).toThrow();
    expect(() => decryptSecret(token, randomBytes(32), crawlSecretScope("c1"))).toThrow();
    const [v, iv, tag, ct] = token.split(".");
    const flipped = Buffer.from(ct, "base64url");
    flipped[0] ^= 1;
    expect(() => decryptSecret([v, iv, tag, flipped.toString("base64url")].join("."), key, crawlSecretScope("c1"))).toThrow();
    expect(() => decryptSecret("v0.a.b.c", key, "s")).toThrow("Unrecognised secret format.");
  });

  it("reads a 32-byte base64 key from CRAWLER_SECRET_KEY", () => {
    expect(secretKey({})).toBeNull();
    expect(secretKey({ CRAWLER_SECRET_KEY: key.toString("base64") })?.equals(key)).toBe(true);
    expect(() => secretKey({ CRAWLER_SECRET_KEY: "dG9vIHNob3J0" })).toThrow("32 random bytes");
  });
});
