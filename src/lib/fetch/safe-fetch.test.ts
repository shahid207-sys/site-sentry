import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fetch } from "undici";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { startDnsStub, type DnsStub } from "@/test/dns-stub";
import { isBlockedIp } from "./ip-guard";
import { createSafeFetch, pinnedAgent, SafeFetchError, validateTargetUrl, type FetchPolicy } from "./safe-fetch";

// The test web server listens on 127.0.0.1. The test policy treats exactly that address as "public" and
// judges every other address with the production block list, so private/metadata answers are still refused.
const TEST_PUBLIC_IP = "127.0.0.1";

let dns: DnsStub;
let server: Server;
let port: number;
const hits: { host: string; path: string }[] = [];
let routes: Record<string, (res: import("node:http").ServerResponse) => void> = {};

beforeAll(async () => {
  dns = await startDnsStub();
  server = createServer((req, res) => {
    hits.push({ host: req.headers.host ?? "", path: req.url ?? "" });
    const handler = routes[req.url ?? ""];
    if (handler) return handler(res);
    res.writeHead(200, { "content-type": "text/html" }).end("<title>ok</title>");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await dns.close();
  await new Promise((r) => server.close(r));
});

afterEach(() => {
  hits.length = 0;
  routes = {};
  dns.queries.clear();
});

const policy = (): FetchPolicy => ({
  resolve: dns.resolve,
  isBlocked: (ip) => (ip === TEST_PUBLIC_IP ? false : isBlockedIp(ip)),
  allowedPorts: new Set(["", String(port)]),
  allowLocalNames: false,
});

async function failure(p: Promise<unknown>): Promise<SafeFetchError> {
  const e = await p.then(
    () => null,
    (err) => err,
  );
  expect(e).toBeInstanceOf(SafeFetchError);
  return e as SafeFetchError;
}

const redirect = (location: string) => (res: import("node:http").ServerResponse) => res.writeHead(302, { location }).end();

describe("safe fetch with a DNS stub", () => {
  it("fetches a host that resolves to an allowed address, keeping the hostname in the Host header", async () => {
    dns.set("site.test", [TEST_PUBLIC_IP]);
    const res = await createSafeFetch(policy())(`http://site.test:${port}/`, { accept: "html" });
    expect(res.status).toBe(200);
    expect(res.body).toContain("ok");
    expect(hits).toEqual([{ host: `site.test:${port}`, path: "/" }]);
  });

  it("resolves once per hop: the connection does not trigger a second DNS lookup", async () => {
    dns.set("once.test", [TEST_PUBLIC_IP]);
    await createSafeFetch(policy())(`http://once.test:${port}/`, { accept: "html" });
    // One A and one AAAA query, both from the validation step; the socket used the pinned address.
    expect(dns.queries.get("once.test")).toBe(2);
  });

  it.each([
    ["RFC1918 10/8", "10.0.0.5"],
    ["RFC1918 192.168/16", "192.168.1.1"],
    ["RFC1918 172.16/12", "172.20.0.1"],
    ["cloud metadata", "169.254.169.254"],
    ["CGNAT", "100.64.0.1"],
    ["loopback other than the test address", "127.0.0.2"],
    ["unspecified", "0.0.0.0"],
    ["IPv6 loopback", "::1"],
    ["IPv6 unique local", "fd00::1"],
    ["IPv6 link-local", "fe80::1"],
    ["IPv4-mapped metadata", "::ffff:a9fe:a9fe"],
    ["NAT64-embedded RFC1918", "64:ff9b::a00:1"],
  ])("refuses a host whose DNS answer is %s (%s) and sends no request", async (_label, ip) => {
    dns.set("evil.test", [ip]);
    const e = await failure(createSafeFetch(policy())(`http://evil.test:${port}/`, { accept: "html" }));
    expect(e.code).toBe("BLOCKED_HOST");
    expect(e.message).toContain("evil.test resolves to");
    expect(hits).toHaveLength(0);
  });

  it("refuses a host with one allowed and one private record", async () => {
    dns.set("mixed.test", [TEST_PUBLIC_IP, "10.1.2.3"]);
    const e = await failure(createSafeFetch(policy())(`http://mixed.test:${port}/`, { accept: "html" }));
    expect(e.code).toBe("BLOCKED_HOST");
    expect(hits).toHaveLength(0);
  });

  it("reports DNS_FAILED for a name that does not exist", async () => {
    const e = await failure(createSafeFetch(policy())(`http://nxdomain.test:${port}/`, { accept: "html" }));
    expect(e.code).toBe("DNS_FAILED");
  });

  it("re-resolves on every redirect hop and refuses a hop to a private address", async () => {
    dns.set("start.test", [TEST_PUBLIC_IP]);
    dns.set("internal.test", ["10.0.0.7"]);
    routes["/go"] = redirect(`http://internal.test:${port}/admin`);
    const e = await failure(createSafeFetch(policy())(`http://start.test:${port}/go`, { accept: "html" }));
    expect(e.code).toBe("BLOCKED_HOST");
    expect(hits).toEqual([{ host: `start.test:${port}`, path: "/go" }]);
    expect(dns.queries.get("internal.test")).toBe(2);
  });

  it("refuses a redirect to a literal metadata address", async () => {
    dns.set("start.test", [TEST_PUBLIC_IP]);
    routes["/meta"] = redirect("http://169.254.169.254/latest/meta-data/");
    const e = await failure(createSafeFetch(policy())(`http://start.test:${port}/meta`, { accept: "html" }));
    expect(e.code).toBe("BLOCKED_HOST");
    expect(hits).toHaveLength(1);
  });

  it("refuses the third hop of a chain when only that hop resolves privately", async () => {
    dns.set("a.test", [TEST_PUBLIC_IP]);
    dns.set("b.test", [TEST_PUBLIC_IP]);
    dns.set("c.test", ["192.168.0.10"]);
    routes["/1"] = redirect(`http://b.test:${port}/2`);
    routes["/2"] = redirect(`http://c.test:${port}/3`);
    const e = await failure(createSafeFetch(policy())(`http://a.test:${port}/1`, { accept: "html" }));
    expect(e.code).toBe("BLOCKED_HOST");
    expect(hits.map((h) => h.path)).toEqual(["/1", "/2"]);
  });

  it("refuses a redirect to a non-http scheme", async () => {
    dns.set("start.test", [TEST_PUBLIC_IP]);
    routes["/file"] = redirect("file:///etc/passwd");
    const e = await failure(createSafeFetch(policy())(`http://start.test:${port}/file`, { accept: "html" }));
    expect(e.code).toBe("INVALID_URL");
  });

  it("DNS rebinding: an answer that changes after validation never reaches the socket, and the next fetch is refused", async () => {
    // First resolution (A + AAAA = queries 1 and 2) is allowed; every later answer is private.
    dns.set("rebind.test", (n) => (n <= 2 ? [TEST_PUBLIC_IP] : ["10.0.0.9"]));
    const fetcher = createSafeFetch(policy());
    const ok = await fetcher(`http://rebind.test:${port}/`, { accept: "html" });
    expect(ok.status).toBe(200);
    expect(dns.queries.get("rebind.test")).toBe(2);
    const e = await failure(fetcher(`http://rebind.test:${port}/again`, { accept: "html" }));
    expect(e.code).toBe("BLOCKED_HOST");
    expect(hits.map((h) => h.path)).toEqual(["/"]);
  });

  it("the production policy refuses the test server's loopback address", async () => {
    dns.set("site.test", [TEST_PUBLIC_IP]);
    const e = await failure(createSafeFetch({ ...policy(), isBlocked: isBlockedIp })(`http://site.test:${port}/`, { accept: "html" }));
    expect(e.code).toBe("BLOCKED_HOST");
    expect(hits).toHaveLength(0);
  });
});

describe("pinned agent", () => {
  it("connects to the pinned address whatever the hostname would resolve to", async () => {
    // .invalid never resolves (RFC 6761); the request still arrives because the socket uses the pin.
    const res = await fetch(`http://pinned.invalid:${port}/pin`, { dispatcher: pinnedAgent("pinned.invalid", "127.0.0.1") });
    expect(res.status).toBe(200);
    await res.body?.cancel();
    expect(hits).toEqual([{ host: `pinned.invalid:${port}`, path: "/pin" }]);
  });
});

describe("validateTargetUrl with the production policy", () => {
  it.each([
    ["decimal IPv4", "http://2852039166/"],
    ["hex IPv4", "http://0xa9.0xfe.0xa9.0xfe/"],
    ["octal IPv4", "http://0251.0376.0251.0376/"],
    ["short IPv4", "http://127.1/"],
    ["bracketed IPv4-mapped IPv6", "http://[::ffff:169.254.169.254]/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["non-standard port", "http://example.com:8080/"],
    ["localhost name", "http://localhost/"],
    ["trailing-dot localhost", "http://localhost./"],
    [".internal name", "http://metadata.google.internal/"],
    ["single-label name", "http://intranet/"],
  ])("refuses %s (%s)", (_label, input) => {
    expect(() => validateTargetUrl(input)).toThrow(SafeFetchError);
  });

  it("accepts a public name", () => {
    expect(validateTargetUrl("https://example.com/a").toString()).toBe("https://example.com/a");
  });
});
