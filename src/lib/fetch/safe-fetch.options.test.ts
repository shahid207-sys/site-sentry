import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { SafeFetchError } from "./safe-fetch";

let srv: LocalServer;
beforeEach(async () => {
  srv = await startLocalServer();
});
afterEach(async () => {
  await srv.close();
});

describe("fetch options used by crawler v2", () => {
  it("returns a 3xx with its resolved Location instead of following it when followRedirects is false", async () => {
    srv.routes.set("/old", send("", "text/html", 301, { location: "new?x=1" }));
    srv.routes.set("/new", send("<title>new</title>"));
    const res = await srv.fetch(`${srv.origin}/old`, { accept: "html", followRedirects: false });
    expect(res).toMatchObject({ status: 301, location: `${srv.origin}/new?x=1`, body: "", redirectChain: [] });
    expect(srv.hits.get("/new?x=1")).toBeUndefined();
  });

  it("still follows redirects by default (legacy engine and verifier)", async () => {
    srv.routes.set("/old", send("", "text/html", 302, { location: "/new" }));
    srv.routes.set("/new", send("<title>new</title>"));
    const res = await srv.fetch(`${srv.origin}/old`, { accept: "html" });
    expect(res).toMatchObject({ status: 200, finalUrl: `${srv.origin}/new` });
  });

  it("applies maxBytes, userAgent and timeoutMs overrides", async () => {
    let ua = "";
    srv.routes.set("/big", (req, res) => {
      ua = req.headers["user-agent"] ?? "";
      res.writeHead(200, { "content-type": "text/html" }).end("x".repeat(5000));
    });
    srv.routes.set("/slow", (_req, res) => void setTimeout(() => res.writeHead(200, { "content-type": "text/html" }).end("late"), 500));
    const big = await srv.fetch(`${srv.origin}/big`, { accept: "html", maxBytes: 1000, userAgent: "TestBot/1" });
    expect(big).toMatchObject({ truncated: true });
    expect(big.body.length).toBeLessThanOrEqual(1000);
    expect(ua).toBe("TestBot/1");
    const slow = srv.fetch(`${srv.origin}/slow`, { accept: "html", timeoutMs: 100 });
    await expect(slow).rejects.toMatchObject({ code: "TIMEOUT" });
    await expect(slow).rejects.toBeInstanceOf(SafeFetchError);
  });
});

describe("extra headers", () => {
  it("are sent on the first origin and dropped when a redirect leaves it", async () => {
    const other = await startLocalServer();
    try {
      const got: Record<string, string | undefined> = {};
      srv.routes.set("/start", (req, res) => {
        got.start = req.headers.authorization;
        res.writeHead(302, { location: `${other.origin}/landing` }).end();
      });
      other.routes.set("/landing", (req, res) => {
        got.landing = req.headers.authorization;
        send("<title>x</title>")(req, res);
      });
      const { createSafeFetch } = await import("./safe-fetch");
      const fetch = createSafeFetch({ resolve: async () => ["127.0.0.1"], isBlocked: () => false, allowedPorts: new Set([String(srv.port), String(other.port)]), allowLocalNames: false });
      const res = await fetch(`${srv.origin}/start`, { accept: "html", headers: { authorization: "Basic eDp5" } });
      expect(res.status).toBe(200);
      expect(got).toEqual({ start: "Basic eDp5", landing: undefined });
    } finally {
      await other.close();
    }
  });
});
