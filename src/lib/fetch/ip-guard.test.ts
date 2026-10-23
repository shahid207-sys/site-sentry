import { describe, expect, it } from "vitest";
import { isBlockedIp } from "./ip-guard";
import { SafeFetchError, validateTargetUrl } from "./safe-fetch";

describe("isBlockedIp", () => {
  it.each([
    "127.0.0.1",
    "127.255.255.254",
    "10.0.0.1",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "[::1]",
    "fe80::1%eth0",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:a9fe:a9fe",
    "64:ff9b::a00:1",
    "64:ff9b::7f00:1",
    "64:ff9b::169.254.169.254",
    "0:0:0:0:0:ffff:7f00:1",
    "64:ff9b:1::1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each(["93.184.215.14", "8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "64:ff9b::14cf:4952", "64:ff9b::8.8.8.8"])(
    "allows public %s",
    (ip) => {
      expect(isBlockedIp(ip)).toBe(false);
    },
  );
});

describe("validateTargetUrl", () => {
  it("adds https:// when the scheme is missing", () => {
    expect(validateTargetUrl("example.com/page").toString()).toBe("https://example.com/page");
  });

  it("strips the fragment", () => {
    expect(validateTargetUrl("https://example.com/a#b").toString()).toBe("https://example.com/a");
  });

  it.each([
    ["", "INVALID_URL"],
    ["ftp://example.com", "INVALID_URL"],
    ["file:///etc/passwd", "INVALID_URL"],
    ["javascript://alert(1)", "INVALID_URL"],
    ["https://user:pass@example.com", "INVALID_URL"],
    ["http://localhost:3000", "BLOCKED_HOST"],
    ["http://localhost", "BLOCKED_HOST"],
    ["http://intranet", "BLOCKED_HOST"],
    ["http://printer.local", "BLOCKED_HOST"],
    ["http://metadata.google.internal", "BLOCKED_HOST"],
    ["https://example.com:22", "BLOCKED_HOST"],
  ])("rejects %s", (input, code) => {
    try {
      validateTargetUrl(input);
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(SafeFetchError);
      expect((e as SafeFetchError).code).toBe(code);
    }
  });
});
