import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/server", async (orig) => ({ ...(await orig<typeof import("next/server")>()), connection: async () => {} }));
vi.mock("@/lib/workspace", () => ({ getStore: () => ({ read: async () => ({}) }), liveScansEnabled: () => true }));

const { GET } = await import("./route");

const health = (headers: Record<string, string> = {}) => new NextRequest("https://audit.example.com/api/health", { headers });
const json = async (headers?: Record<string, string>) => (await GET(health(headers))).json();

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/health", () => {
  it("shows no configuration to the public, with or without a token sent", async () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    vi.stubEnv("ADMIN_TOKEN", "s3cret-admin-token");
    const expected = { status: "ok", checks: { store_live: "ok", store_sample: "ok" }, liveScans: true };
    expect(await json()).toEqual(expected);
    expect(await json({ authorization: "Bearer wrong" })).toEqual(expected);
    vi.stubEnv("ADMIN_TOKEN", "");
    expect(await json({ authorization: "Bearer " })).toEqual(expected); // no ADMIN_TOKEN: nobody is an admin
  });

  it("tells an admin why the quick audit cannot identify clients", async () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "");
    vi.stubEnv("ADMIN_TOKEN", "s3cret-admin-token");
    const body = await json({ authorization: "Bearer s3cret-admin-token" });
    expect(body.admin.quickAudit).toEqual({ clientAddress: "unavailable", reason: expect.stringContaining("TRUSTED_PROXY_HEADER is not set") });
  });

  it("reports a configured proxy header to an admin", async () => {
    vi.stubEnv("TRUSTED_PROXY_HEADER", "cf-connecting-ip");
    vi.stubEnv("ADMIN_TOKEN", "s3cret-admin-token");
    expect((await json({ authorization: "bearer s3cret-admin-token" })).admin).toEqual({ quickAudit: { clientAddress: "configured" } });
  });
});
