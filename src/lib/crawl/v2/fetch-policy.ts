// The fetch policy the crawl worker uses. Production: the default SSRF policy. For the local fixture site and the
// worker integration tests, CRAWLER_LOCAL_HOSTS maps named test hosts to loopback; this is refused in production.
import { isBlockedIp } from "../../fetch/ip-guard";
import { DEFAULT_POLICY, systemResolve, type FetchPolicy } from "../../fetch/safe-fetch";

/**
 * CRAWLER_LOCAL_HOSTS="site.test=127.0.0.1,other.test=127.0.0.1" and CRAWLER_LOCAL_PORTS="8081,8082".
 * Only the listed names resolve to the listed addresses, and only those addresses are let through the IP guard.
 */
export function workerFetchPolicy(env: Record<string, string | undefined> = process.env): FetchPolicy {
  const raw = env.CRAWLER_LOCAL_HOSTS?.trim();
  if (!raw) return DEFAULT_POLICY;
  if (env.NODE_ENV === "production") throw new Error("CRAWLER_LOCAL_HOSTS is a test setting and is refused when NODE_ENV=production.");
  const table = new Map<string, string>();
  for (const pair of raw.split(",")) {
    const [host, ip] = pair.split("=").map((s) => s.trim().toLowerCase());
    if (!host || !ip || !host.endsWith(".test")) throw new Error(`CRAWLER_LOCAL_HOSTS: "${pair}" must be <name>.test=<ip>.`);
    table.set(host, ip);
  }
  const allowedIps = new Set(table.values());
  const ports = new Set(DEFAULT_POLICY.allowedPorts);
  for (const p of (env.CRAWLER_LOCAL_PORTS ?? "").split(",").map((s) => s.trim()).filter(Boolean)) ports.add(p);
  return {
    resolve: async (hostname) => {
      const ip = table.get(hostname.toLowerCase());
      return ip ? [ip] : systemResolve(hostname);
    },
    isBlocked: (ip) => !allowedIps.has(ip) && isBlockedIp(ip),
    allowedPorts: ports,
    allowLocalNames: false,
  };
}
