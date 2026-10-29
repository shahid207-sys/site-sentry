// Spec "Crawler engine → Politeness and speed" fetch limits: TLS failures get their own code, undici timeouts are
// timeouts, and a request's own total timeout (30 s for crawler v2) is not cut short by the agent's socket timeouts.
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { generate } from "selfsigned";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalServer } from "@/test/local-server";
import { isBlockedIp } from "./ip-guard";
import { classifyTransportError, createPeerCertReader, createSafeFetch, SafeFetchError } from "./safe-fetch";

let tls: Server;
let port = 0;
let cert = "";
beforeAll(async () => {
  // A throwaway self-signed certificate for tls.test, made per run so no private key is kept in the repo.
  const pems = await generate([{ name: "commonName", value: "tls.test" }], { keyType: "ec", algorithm: "sha256" });
  cert = pems.cert;
  tls = createServer({ key: pems.private, cert: pems.cert }, (_req, res) => res.writeHead(200, { "content-type": "text/html" }).end("<title>secret</title>"));
  await new Promise<void>((r) => tls.listen(0, "127.0.0.1", r));
  port = (tls.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((r) => tls.close(() => r())));

describe("fetch limits", () => {
  it("reports an untrusted certificate as TLS, not as a generic network error", async () => {
    const fetch = createSafeFetch({
      resolve: async () => ["127.0.0.1"],
      isBlocked: (ip) => ip !== "127.0.0.1" && isBlockedIp(ip),
      allowedPorts: new Set([String(port)]),
      allowLocalNames: false,
    });
    const err = await fetch(`https://tls.test:${port}/`, { accept: "html" }).catch((e) => e);
    expect(err).toBeInstanceOf(SafeFetchError);
    expect(err).toMatchObject({ code: "TLS", message: "TLS connection failed (DEPTH_ZERO_SELF_SIGNED_CERT)." });
  });

  it("trusts a certificate the policy lists in ca, and only that policy", async () => {
    const policy = { resolve: async () => ["127.0.0.1"], isBlocked: (ip: string) => ip !== "127.0.0.1" && isBlockedIp(ip), allowedPorts: new Set([String(port)]), allowLocalNames: false };
    const trusted = createSafeFetch({ ...policy, ca: [cert] });
    expect(await trusted(`https://tls.test:${port}/`, { accept: "html" })).toMatchObject({ status: 200, body: "<title>secret</title>" });
    // Same host and address, no ca: a separate agent, so the trusted connection is not reused.
    await expect(createSafeFetch(policy)(`https://tls.test:${port}/`, { accept: "html" })).rejects.toMatchObject({ code: "TLS" });
  });

  it("reads an expired certificate by handshake alone, with the fetch's SSRF guards (SEC-003)", async () => {
    const day = 86_400_000;
    const pems = await generate([{ name: "commonName", value: "old.test" }], {
      keyType: "ec",
      algorithm: "sha256",
      notBeforeDate: new Date(Date.now() - 30 * day),
      notAfterDate: new Date(Date.now() - day),
      extensions: [{ name: "subjectAltName", altNames: [{ type: 2, value: "old.test" }] }],
    });
    let requests = 0;
    const old = createServer({ key: pems.private, cert: pems.cert }, (_req, res) => (requests++, res.end()));
    await new Promise<void>((r) => old.listen(0, "127.0.0.1", r));
    const oldPort = (old.address() as AddressInfo).port;
    try {
      const policy = { resolve: async () => ["127.0.0.1"], isBlocked: (ip: string) => ip !== "127.0.0.1" && isBlockedIp(ip), allowedPorts: new Set([String(oldPort)]), allowLocalNames: false };
      const c = await createPeerCertReader({ ...policy, ca: [pems.cert] })(`https://old.test:${oldPort}/`);
      expect(c).toMatchObject({ subject: "old.test", altNames: ["old.test"], authorized: false, authorizationError: "CERT_HAS_EXPIRED" });
      expect(Date.parse(c.validTo)).toBeLessThan(Date.now());
      expect(requests).toBe(0); // no HTTP request is ever written on the socket

      // The same guards as a fetch: production policy refuses loopback, a private DNS answer and plain http.
      await expect(createPeerCertReader()(`https://127.0.0.1:${oldPort}/`)).rejects.toMatchObject({ code: "BLOCKED_HOST" });
      await expect(createPeerCertReader({ ...policy, resolve: async () => ["10.0.0.5"] })(`https://old.test:${oldPort}/`)).rejects.toMatchObject({ code: "BLOCKED_HOST" });
      await expect(createPeerCertReader(policy)(`http://old.test:${oldPort}/`)).rejects.toMatchObject({ code: "INVALID_URL" });
    } finally {
      await new Promise<void>((r) => old.close(() => r()));
    }
  });

  it("classifies undici timeouts and TLS codes found anywhere in the cause chain", () => {
    const wrap = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("inner"), { code }) });
    expect(classifyTransportError(wrap("UND_ERR_CONNECT_TIMEOUT"))).toEqual({ code: "TIMEOUT", detail: "UND_ERR_CONNECT_TIMEOUT" });
    expect(classifyTransportError(wrap("UND_ERR_HEADERS_TIMEOUT"))).toEqual({ code: "TIMEOUT", detail: "UND_ERR_HEADERS_TIMEOUT" });
    expect(classifyTransportError(wrap("CERT_HAS_EXPIRED"))).toEqual({ code: "TLS", detail: "CERT_HAS_EXPIRED" });
    expect(classifyTransportError(wrap("ERR_TLS_CERT_ALTNAME_INVALID"))).toEqual({ code: "TLS", detail: "ERR_TLS_CERT_ALTNAME_INVALID" });
    expect(classifyTransportError(wrap("ECONNRESET"))).toBeNull();
    expect(classifyTransportError(new Error("no code"))).toBeNull();
  });

  it("lets a 30 s request wait longer than 10 s for headers", { timeout: 20_000 }, async () => {
    const srv = await startLocalServer();
    try {
      srv.routes.set("/slow", (_req, res) => void setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end("<title>late</title>"), 11_000));
      const res = await srv.fetch(`${srv.origin}/slow`, { accept: "html", timeoutMs: 30_000 });
      expect(res).toMatchObject({ status: 200, body: "<title>late</title>" });
      expect(res.elapsedMs).toBeGreaterThanOrEqual(10_900);
    } finally {
      await srv.close();
    }
  });
});
