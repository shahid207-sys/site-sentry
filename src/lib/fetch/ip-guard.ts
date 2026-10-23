import { BlockList, isIP } from "node:net";

// Address ranges a server-side fetcher must never connect to (SSRF protection).
const blocked = new BlockList();

const V4: [string, number][] = [
  ["0.0.0.0", 8], // "this" network
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, incl. cloud metadata 169.254.169.254
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + broadcast
];

const V6: [string, number][] = [
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["::", 96], // deprecated IPv4-compatible
  ["64:ff9b:1::", 48], // local-use NAT64
  ["100::", 64], // discard-only
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 (can embed private v4)
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
];

for (const [net, prefix] of V4) blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of V6) blocked.addSubnet(net, prefix, "ipv6");

/** Expand a valid IPv6 literal into its 8 16-bit groups (handles :: and a trailing dotted quad). */
function hextets(ip: string): number[] {
  let s = ip.toLowerCase();
  const dotted = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    s = s.slice(0, dotted.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.includes("::") ? s.split("::") : [s, null];
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = tail === null ? [] : Array(8 - h.length - t.length).fill("0");
  return [...h, ...fill, ...t].map((x) => parseInt(x, 16));
}

/**
 * IPv6 forms that carry an IPv4 address the packet will actually reach:
 * IPv4-mapped (::ffff:0:0/96) and the NAT64 well-known prefix (64:ff9b::/96).
 * DNS64 networks return 64:ff9b::/96 for every public site, so these must be judged by the embedded IPv4.
 */
function embeddedV4(ip: string): string | null {
  const h = hextets(ip);
  const mapped = h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff;
  const nat64 = h[0] === 0x64 && h[1] === 0xff9b && h.slice(2, 6).every((x) => x === 0);
  if (!mapped && !nat64) return null;
  return [h[6] >> 8, h[6] & 0xff, h[7] >> 8, h[7] & 0xff].join(".");
}

/** True if the IP literal must not be fetched. Non-IP strings are treated as blocked. */
export function isBlockedIp(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, "").replace(/%.*$/, ""); // strip brackets and zone id
  const family = isIP(bare);
  if (family === 4) return blocked.check(bare, "ipv4");
  if (family === 6) {
    const v4 = embeddedV4(bare);
    if (v4) return blocked.check(v4, "ipv4");
    return blocked.check(bare, "ipv6");
  }
  return true;
}
