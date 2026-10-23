import { fetch } from "undici";
import { describe, expect, it } from "vitest";
import { agent, SafeFetchError } from "./safe-fetch";

describe("connect-time lookup guard", () => {
  // Bypasses the pre-check entirely: proves the socket-level lookup refuses
  // private addresses (DNS-rebinding protection). localhost resolves via the hosts file.
  it("refuses to connect when the hostname resolves to a private address", async () => {
    const err = await fetch("http://localhost/", { dispatcher: agent }).catch((e) => e);
    let cur: unknown = err;
    while (cur && !(cur instanceof SafeFetchError)) cur = (cur as { cause?: unknown }).cause;
    expect(cur).toBeInstanceOf(SafeFetchError);
    expect((cur as SafeFetchError).code).toBe("BLOCKED_HOST");
  });
});
