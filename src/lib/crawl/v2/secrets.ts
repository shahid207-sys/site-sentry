// Staging-site credentials at rest (docs/SPEC.md "Security": "stored encrypted and scoped to one project").
// AES-256-GCM with a server key from CRAWLER_SECRET_KEY. The crawl id is bound in as associated data, so a
// ciphertext copied onto another crawl does not decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION = "v1";

/** The 32-byte key from CRAWLER_SECRET_KEY (base64), or null when it is not configured. */
export function secretKey(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.CRAWLER_SECRET_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("CRAWLER_SECRET_KEY must be 32 random bytes, base64-encoded (openssl rand -base64 32).");
  return key;
}

export function encryptSecret(plain: string, key: Buffer, scope: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(scope));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

/** Throws when the token was not made with this key and scope, or was altered. */
export function decryptSecret(token: string, key: Buffer, scope: string): string {
  const [version, iv, tag, ct] = token.split(".");
  if (version !== VERSION || !iv || !tag || ct === undefined) throw new Error("Unrecognised secret format.");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAAD(Buffer.from(scope));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64url")), decipher.final()]).toString("utf8");
}

/** Associated data for a crawl's credentials. */
export const crawlSecretScope = (crawlId: string) => `crawl-auth:${crawlId}`;
