// The crawler's public identity: the product token that robots.txt groups are matched against, and the user-agent
// string sent with every request. Operators of a deployment set their own with CRAWLER_BOT_NAME and CRAWLER_BOT_URL
// (docs/BOT.md). Read once when the module loads, so the web app and every worker must see the same environment.

export const DEFAULT_BOT_NAME = "SiteSentryBot";
export const BOT_VERSION = "1.0";

/** A robots.txt product token: letters, digits, dot, underscore and hyphen only (RFC 9309 §2.2.1). */
const TOKEN = /^[A-Za-z][A-Za-z0-9._-]{0,39}$/;

export function resolveBotName(env: Record<string, string | undefined>): string {
  const raw = env.CRAWLER_BOT_NAME?.trim();
  if (!raw) return DEFAULT_BOT_NAME;
  if (!TOKEN.test(raw)) throw new Error("CRAWLER_BOT_NAME must be a robots.txt product token: 1–40 letters, digits, '.', '_' or '-', starting with a letter.");
  return raw;
}

/** The info URL, or null when unset. There is deliberately no default: we do not claim a domain the deployment does not own. */
export function resolveBotUrl(env: Record<string, string | undefined>): string | null {
  const raw = env.CRAWLER_BOT_URL?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("CRAWLER_BOT_URL must be an absolute http(s) URL, e.g. https://example.com/bot.");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || /[\s()]/.test(raw)) {
    throw new Error("CRAWLER_BOT_URL must be an absolute http(s) URL without credentials, spaces or parentheses.");
  }
  return url.toString();
}

export function botUserAgent(name: string, url: string | null): string {
  return url ? `${name}/${BOT_VERSION} (+${url})` : `${name}/${BOT_VERSION}`;
}

export const BOT_NAME = resolveBotName(process.env);
export const BOT_URL = resolveBotUrl(process.env);
export const BOT_USER_AGENT = botUserAgent(BOT_NAME, BOT_URL);
