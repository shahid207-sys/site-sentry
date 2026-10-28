import { describe, expect, it } from "vitest";
import { DEFAULT_POLICY } from "../../fetch/safe-fetch";
import { workerFetchPolicy } from "./fetch-policy";

describe("workerFetchPolicy", () => {
  it("is the production SSRF policy unless CRAWLER_LOCAL_HOSTS is set", () => {
    expect(workerFetchPolicy({})).toBe(DEFAULT_POLICY);
  });

  it("refuses the local-host mapping when NODE_ENV=production", () => {
    expect(() => workerFetchPolicy({ NODE_ENV: "production", CRAWLER_LOCAL_HOSTS: "site.test=127.0.0.1" })).toThrow(/refused/);
  });

  it("only accepts *.test names", () => {
    expect(() => workerFetchPolicy({ CRAWLER_LOCAL_HOSTS: "example.com=127.0.0.1" })).toThrow(/\.test/);
  });

  it("maps listed names to loopback and lets only those addresses through", async () => {
    const p = workerFetchPolicy({ CRAWLER_LOCAL_HOSTS: "site.test=127.0.0.1", CRAWLER_LOCAL_PORTS: "8081" });
    expect(await p.resolve("SITE.test")).toEqual(["127.0.0.1"]);
    expect(p.isBlocked("127.0.0.1")).toBe(false);
    expect(p.isBlocked("127.0.0.2")).toBe(true);
    expect(p.isBlocked("169.254.169.254")).toBe(true);
    expect(p.allowedPorts.has("8081")).toBe(true);
    expect(p.allowedPorts.has("443")).toBe(true);
    expect(p.allowedPorts.has("22")).toBe(false);
  });
});
