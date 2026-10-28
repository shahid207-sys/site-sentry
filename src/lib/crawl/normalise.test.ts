import { describe, expect, it } from "vitest";
import { MAX_URL_LENGTH, normaliseOrNull, normaliseUrl, variantKey } from "./normalise";

const n = (input: string, base?: string, dropParams?: (string | RegExp)[]) => normaliseOrNull(input, { base, dropParams });

describe("normaliseUrl: spec rules", () => {
  it.each([
    ["lower-cases the scheme", "HTTP://example.com/", "http://example.com/"],
    ["lower-cases the host", "https://Example.COM/Path", "https://example.com/Path"],
    ["keeps path case", "https://example.com/About/Team", "https://example.com/About/Team"],
    ["strips the fragment", "https://example.com/a#section", "https://example.com/a"],
    ["strips an empty fragment", "https://example.com/a#", "https://example.com/a"],
    ["removes the default http port", "http://example.com:80/a", "http://example.com/a"],
    ["removes the default https port", "https://example.com:443/a", "https://example.com/a"],
    ["keeps a non-default port", "https://example.com:8443/a", "https://example.com:8443/a"],
    ["keeps port 443 on http (not its default)", "http://example.com:443/", "http://example.com:443/"],
    ["sorts query parameters by name", "https://example.com/?b=2&a=1&c=3", "https://example.com/?a=1&b=2&c=3"],
    ["keeps the order of repeated names (stable sort)", "https://example.com/?z=1&a=2&a=1", "https://example.com/?a=2&a=1&z=1"],
    ["drops utm_* parameters", "https://example.com/p?utm_source=x&id=7&utm_medium=y", "https://example.com/p?id=7"],
    ["drops tracking parameters whatever their case", "https://example.com/p?UTM_Source=x&GCLID=1&id=7", "https://example.com/p?id=7"],
    ["drops gclid and fbclid", "https://example.com/p?gclid=abc&fbclid=def&q=1", "https://example.com/p?q=1"],
    ["drops a percent-encoded tracking name", "https://example.com/p?utm%5Fsource=x&q=1", "https://example.com/p?q=1"],
    ["removes the ? when only tracking parameters were present", "https://example.com/p?utm_campaign=z", "https://example.com/p"],
    ["keeps parameters that merely contain utm", "https://example.com/p?notutm_x=1", "https://example.com/p?notutm_x=1"],
    ["treats trailing-slash variants as distinct", "https://example.com/blog/", "https://example.com/blog/"],
  ])("%s", (_label, input, expected) => {
    expect(n(input)).toBe(expected);
  });

  it("resolves relative paths against the base", () => {
    expect(n("../c/d?x=1", "https://example.com/a/b/page")).toBe("https://example.com/a/c/d?x=1");
    expect(n("sibling", "https://example.com/a/b/")).toBe("https://example.com/a/b/sibling");
    expect(n("/root", "https://example.com/a/b/")).toBe("https://example.com/root");
  });

  it("resolves a protocol-relative reference with the base's scheme", () => {
    expect(n("//cdn.example.com/x.js", "https://example.com/")).toBe("https://cdn.example.com/x.js");
  });

  it("resolves a fragment-only reference to the base page without the fragment", () => {
    expect(n("#top", "https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
  });

  it("keeps the original URL as found, for evidence", () => {
    const r = normaliseUrl(" HTTP://Example.com:80/a?utm_source=x#f ");
    expect(r).toEqual({ ok: true, url: "http://example.com/a", original: " HTTP://Example.com:80/a?utm_source=x#f " });
  });

  it("drops configured parameters in addition to the defaults when given a list", () => {
    expect(n("https://example.com/?sessionid=9&utm_source=x&q=1", undefined, [/^utm_/, "gclid", "fbclid", "sessionid"])).toBe("https://example.com/?q=1");
  });
});

describe("normaliseUrl: WHATWG behaviour where the spec is silent", () => {
  it.each([
    ["removes dot segments", "https://example.com/a/./b/../c", "https://example.com/a/c"],
    ["treats %2e%2e as a dot segment", "https://example.com/a/%2e%2e/b", "https://example.com/b"],
    ["turns an empty path into /", "https://example.com", "https://example.com/"],
    ["converts backslashes in special URLs", "https:\\\\example.com\\a\\b", "https://example.com/a/b"],
    ["trims surrounding whitespace and removes tabs/newlines", "  https://exa\tmple.com/a\nb  ", "https://example.com/ab"],
    ["IDNA-encodes an internationalised host", "https://bücher.example/", "https://xn--bcher-kva.example/"],
    ["percent-encodes non-ASCII path characters", "https://example.com/café", "https://example.com/caf%C3%A9"],
    ["does not decode percent-encoded unreserved characters", "https://example.com/a%7Eb", "https://example.com/a%7Eb"],
    ["canonicalises a decimal IPv4 host", "http://3232235777/", "http://192.168.1.1/"],
    ["canonicalises an IPv6 host", "http://[2001:DB8:0:0:0:0:0:1]/", "http://[2001:db8::1]/"],
    ["keeps a trailing dot on the host", "https://example.com./a", "https://example.com./a"],
    ["drops a bare ?", "https://example.com/a?", "https://example.com/a"],
    ["drops empty query segments", "https://example.com/a?&&b=1&&", "https://example.com/a?b=1"],
    ["keeps a name without = distinct from name=", "https://example.com/a?x&y=", "https://example.com/a?x&y="],
    ["keeps query percent-encoding byte for byte", "https://example.com/s?q=a%20b&r=a+b", "https://example.com/s?q=a%20b&r=a+b"],
    ["keeps an encoded & inside a value", "https://example.com/s?b=1&a=x%26y", "https://example.com/s?a=x%26y&b=1"],
  ])("%s", (_label, input, expected) => {
    expect(n(input)).toBe(expected);
  });
});

describe("normaliseUrl: rejections", () => {
  it.each([
    ["mailto:", "mailto:a@example.com", "unsupported_scheme"],
    ["javascript:", "javascript:void(0)", "unsupported_scheme"],
    ["tel:", "tel:+971000000", "unsupported_scheme"],
    ["ftp:", "ftp://example.com/file", "unsupported_scheme"],
    ["data:", "data:text/html,hi", "unsupported_scheme"],
    ["credentials in the URL", "https://user:pass@example.com/", "credentials"],
    ["a username alone", "https://user@example.com/", "credentials"],
    ["an unparseable URL", "http://", "invalid"],
    ["a relative URL without a base", "/just/a/path", "invalid"],
    ["an over-long URL", `https://example.com/${"a".repeat(MAX_URL_LENGTH)}`, "too_long"],
  ])("rejects %s", (_label, input, reason) => {
    const r = normaliseUrl(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe(reason);
      expect(r.original).toBe(input);
    }
  });
});

describe("normaliseUrl: properties", () => {
  const samples = [
    "HTTP://Example.com:80/a/./b/../c?z=1&utm_source=q&a=2#x",
    "https://bücher.example/café?b=%20&a",
    "https://example.com/blog/?fbclid=1&page=2&page=1",
    "http://[2001:DB8::1]:8080/x?y",
  ];
  it.each(samples)("is idempotent for %s", (input) => {
    const once = n(input)!;
    expect(once).not.toBeNull();
    expect(n(once)).toBe(once);
  });
});

describe("variantKey", () => {
  it("groups trailing-slash and path-case variants, which stay distinct URLs", () => {
    const urls = ["https://example.com/About/", "https://example.com/about", "https://example.com/ABOUT"].map((u) => n(u)!);
    expect(new Set(urls).size).toBe(3);
    expect(new Set(urls.map(variantKey)).size).toBe(1);
  });

  it("keeps the root path and the query in the key", () => {
    expect(variantKey("https://example.com/")).toBe("https://example.com/");
    expect(variantKey("https://example.com/a/?q=1")).not.toBe(variantKey("https://example.com/a/?q=2"));
  });
});
