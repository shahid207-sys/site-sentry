// Shape check for the homepage audit form. Safe for the browser; the server re-validates every
// address and enforces the SSRF rules (src/lib/fetch/safe-fetch.ts), so this only gives early, friendly errors.
export function parsePublicUrl(raw: string): { url: string } | { error: string } {
  const v = raw.trim();
  if (!v) return { error: "Enter the address of a public website, such as example.com." };
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(v) ? v : `https://${v}`);
  } catch {
    return { error: "That doesn't look like a web address. Try something like example.com." };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return { error: "Only http:// and https:// addresses can be audited." };
  if (u.username || u.password) return { error: "Remove the username or password from the address." };
  const host = u.hostname.toLowerCase();
  if (!host.includes(".") || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return { error: "Enter a public website address. Local and internal hosts can't be audited." };
  }
  u.hash = "";
  return { url: u.toString() };
}
