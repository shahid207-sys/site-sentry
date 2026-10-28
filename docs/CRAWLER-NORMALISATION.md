# Crawler URL normalisation

Implementation: `src/lib/crawl/normalise.ts` (`normaliseUrl`, `normaliseOrNull`, `variantKey`).
Tests: `src/lib/crawl/normalise.test.ts`.

Used only by crawler v2 (`CRAWLER_V2=true`). The legacy engine keeps `src/lib/crawl/url.ts` (`normalizePageUrl`) because
its output is part of stored issue fingerprints. Phase 3 rebuilds fingerprints and retires it.

## Rules from the spec ("Crawler engine → URL normalisation")

| Rule | How |
|---|---|
| Lowercase scheme and host | WHATWG parser |
| Strip fragments | `url.hash = ""` |
| Resolve relative paths | `new URL(input, base)`; the caller passes the page URL or its `<base href>` |
| Remove default ports | WHATWG parser (80 for http, 443 for https only) |
| Sort query parameters | See "Query" below |
| Drop tracking parameters | `utm_*`, `gclid`, `fbclid` by default (`DEFAULT_TRACKING_PARAMS`); callers can pass a longer list |
| Keep the original URL as found | Returned as `original` on every result, success or failure |
| Trailing-slash and case variants are distinct | Path is never case-folded and slashes are never added or removed. `variantKey()` gives such variants a shared key so they can be flagged as duplicates |

## Choices where the spec is silent

Each choice follows the WHATWG URL Standard unless the row says otherwise.

| Topic | Choice | Basis |
|---|---|---|
| Dot segments (`.`, `..`, `%2e%2e`) | Resolved | WHATWG |
| Backslashes in http(s) URLs | Converted to `/` | WHATWG |
| Leading/trailing C0 and space; tab/newline inside | Stripped | WHATWG |
| Empty path | `/` | WHATWG |
| Internationalised host | IDNA (punycode) | WHATWG |
| Non-ASCII in path or query | Percent-encoded (UTF-8) | WHATWG |
| Percent-encoded unreserved characters (`%7E`) | **Not** decoded; hex case not changed | WHATWG (does not decode). RFC 3986 §6.2.2 would decode, but servers may differ, so they stay distinct |
| IPv4 in decimal, hex, octal or short form | Canonical dotted quad | WHATWG |
| IPv6 host | Lower-case, compressed | WHATWG |
| Trailing dot on host (`example.com.`) | Kept | WHATWG (a distinct host string) |
| Query sorting | Stable sort by **raw** parameter name in code-unit order. Repeated names keep their relative order (`a=2&a=1` stays). Pairs are not re-encoded, so `%20` vs `+` and `%26` are kept byte for byte | WHATWG `URLSearchParams.sort()` ordering, but without its form-urlencoded re-serialisation, which would rewrite bytes |
| Empty query (`?`, `?&&`) | Removed; empty segments dropped | Deviation: WHATWG keeps a bare `?`. The spec rebuilds the query, and an empty query carries no parameters |
| `x` vs `x=` | Kept distinct | Raw pairs are not re-serialised |
| Tracking-parameter matching | Case-insensitive on the percent-decoded name (`UTM_Source`, `utm%5Fsource` both dropped) | Choice: tracking tags are routinely upper-cased or encoded by link builders |
| Schemes | Only `http:` and `https:`. Others are rejected with reason `unsupported_scheme` | Spec "Security": http/https only |
| Userinfo (`user:pass@`) | Rejected with reason `credentials` | Deviation: WHATWG keeps it. Credentials must never be stored in URL rows; authenticated crawls use project-scoped, encrypted auth (spec "Security") |
| Length | Normalised URLs over 2,048 characters are rejected with reason `too_long` | Choice: matches the existing `validateTargetUrl` input cap |
| Unparseable input, or relative input without a base | Rejected with reason `invalid` | WHATWG parse failure |

Rejected URLs are not dropped silently. The crawler records them with a terminal state (`out_of_scope` with the
reason) so they appear in the report's per-state counts.

## Properties covered by tests

- Idempotence: `normalise(normalise(x)) === normalise(x)`.
- Trailing-slash and path-case variants normalise to different URLs with the same `variantKey`.
