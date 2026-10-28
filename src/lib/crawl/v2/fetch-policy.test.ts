import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { send, startLocalServer, type LocalServer } from "@/test/local-server";
import { createSafeFetch, DEFAULT_POLICY } from "../../fetch/safe-fetch";
import { workerFetchPolicy } from "./fetch-policy";

const TEST = { NODE_ENV: "test" };

describe("workerFetchPolicy", () => {
  it("is the default SSRF policy unless CRAWLER_LOCAL_HOSTS is set", () => {
    expect(workerFetchPolicy({})).toBe(DEFAULT_POLICY);
    expect(workerFetchPolicy({ NODE_ENV: "production" })).toBe(DEFAULT_POLICY);
    expect(workerFetchPolicy({ NODE_ENV: "production", CRAWLER_LOCAL_PORTS: "8081" })).toBe(DEFAULT_POLICY); // ports alone open nothing
  });

  it.each([["production"], ["development"], [undefined], [""], ["TEST"], ["test "]])("refuses the local-host mapping when NODE_ENV is %j", (nodeEnv) => {
    expect(() => workerFetchPolicy({ NODE_ENV: nodeEnv, CRAWLER_LOCAL_HOSTS: "site.test=127.0.0.1" })).toThrow(/refused unless NODE_ENV=test/);
  });

  it("only accepts *.test names", () => {
    expect(() => workerFetchPolicy({ ...TEST, CRAWLER_LOCAL_HOSTS: "example.com=127.0.0.1" })).toThrow(/\.test/);
  });

  it("maps listed names to loopback and lets only those addresses through", async () => {
    const p = workerFetchPolicy({ ...TEST, CRAWLER_LOCAL_HOSTS: "site.test=127.0.0.1", CRAWLER_LOCAL_PORTS: "8081" });
    expect(await p.resolve("SITE.test")).toEqual(["127.0.0.1"]);
    expect(p.isBlocked("127.0.0.1")).toBe(false);
    expect(p.isBlocked("127.0.0.2")).toBe(true);
    expect(p.isBlocked("169.254.169.254")).toBe(true);
    expect(p.allowedPorts.has("8081")).toBe(true);
    expect(p.allowedPorts.has("443")).toBe(true);
    expect(p.allowedPorts.has("22")).toBe(false);
  });
});

describe("the production worker policy against a real local server", () => {
  let srv: LocalServer;
  beforeEach(async () => {
    srv = await startLocalServer({ "/": send("<title>local</title>") });
  });
  afterEach(async () => {
    await srv.close();
  });

  it("the test policy reaches it (control)", async () => {
    const fetch = createSafeFetch(workerFetchPolicy({ ...TEST, CRAWLER_LOCAL_HOSTS: "site.test=127.0.0.1", CRAWLER_LOCAL_PORTS: String(srv.port) }));
    expect((await fetch(`http://site.test:${srv.port}/`, { accept: "html" })).status).toBe(200);
    expect(srv.hits.get("/")).toBe(1);
  });

  it("blocks it: the production policy never sends a request to loopback", async () => {
    const fetch = createSafeFetch(workerFetchPolicy({ NODE_ENV: "production" }));
    await expect(fetch(`http://127.0.0.1:${srv.port}/`, { accept: "html" })).rejects.toMatchObject({ code: "BLOCKED_HOST" });
    await expect(fetch(`http://localhost:${srv.port}/`, { accept: "html" })).rejects.toMatchObject({ code: "BLOCKED_HOST" });
    // Even with the server's port allowed, the address itself is refused: this isolates the IP guard from the port rule.
    const portOpen = createSafeFetch({ ...workerFetchPolicy({ NODE_ENV: "production" }), allowedPorts: new Set([String(srv.port)]) });
    await expect(portOpen(`http://127.0.0.1:${srv.port}/`, { accept: "html" })).rejects.toThrow("Refusing to fetch a private or reserved address");
    expect(srv.hits.size).toBe(0);
  });

  it("refuses to build the policy at all if the test mapping leaks into production", () => {
    expect(() => workerFetchPolicy({ NODE_ENV: "production", CRAWLER_LOCAL_HOSTS: "site.test=127.0.0.1", CRAWLER_LOCAL_PORTS: String(srv.port) })).toThrow(/refused/);
  });
});
