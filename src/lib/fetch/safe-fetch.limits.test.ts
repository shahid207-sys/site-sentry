// Spec "Crawler engine → Politeness and speed" fetch limits: TLS failures get their own code, undici timeouts are
// timeouts, and a request's own total timeout (30 s for crawler v2) is not cut short by the agent's socket timeouts.
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { generate } from "selfsigned";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startLocalServer } from "@/test/local-server";
import { isBlockedIp } from "./ip-guard";
import { classifyTransportError, createSafeFetch, SafeFetchError } from "./safe-fetch";

let tls: Server;
let port = 0;
beforeAll(async () => {
  // A throwaway self-signed certificate for tls.test, made per run so no private key is kept in the repo.
  const pems = await generate([{ name: "commonName", value: "tls.test" }], { keyType: "ec", algorithm: "sha256" });
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
