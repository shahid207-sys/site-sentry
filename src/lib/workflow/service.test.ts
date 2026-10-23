import { describe, expect, it } from "vitest";
import { SafeFetchError } from "../fetch/safe-fetch";
import { MemoryStore } from "../store/store";
import type { FetchedPage, LiveFetcher } from "./pages";
import { runAudit, setExpectations, setSampleState, trackFinding, verifyFinding, type Deps } from "./service";

const PAGE_URL = "https://shop.example.com/shoes";
const html = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body></body></html>`;
const LONG = "Trail Running Shoes for Men and Women | Free Shipping on All Orders | Example Store"; // 82
const FIXED = "Trail Running Shoes for Men and Women | Example Store"; // 52

const page = (body: string, over: Partial<FetchedPage> = {}): FetchedPage => ({
  source: "live",
  requestedUrl: PAGE_URL,
  finalUrl: PAGE_URL,
  status: 200,
  redirectChain: [],
  html: body,
  bytes: body.length,
  truncated: false,
  headers: {},
  ...over,
});

/** Test harness: a fake live site whose response we control, plus a deterministic clock and ids. */
function harness() {
  let respond: () => FetchedPage = () => page(html(LONG));
  let t = Date.parse("2026-10-23T10:00:00Z");
  let n = 0;
  const fetchLive: LiveFetcher = async () => respond();
  const deps: Deps = {
    store: new MemoryStore(),
    fetchLive,
    now: () => new Date((t += 60_000)),
    newId: () => `id-${++n}`,
  };
  return {
    deps,
    serve(fn: () => FetchedPage) {
      respond = fn;
    },
    async trackTooLong() {
      const audit = await runAudit({ url: PAGE_URL }, deps);
      return trackFinding(audit.id, "title/too-long", deps);
    },
  };
}

describe("verification outcomes", () => {
  it("resolved: the fixed page passes the original acceptance criteria", async () => {
    const h = harness();
    const tracked = await h.trackTooLong();
    h.serve(() => page(html(FIXED)));

    const after = await verifyFinding(tracked.id, h.deps);

    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0].outcome).toBe("resolved");
    expect(after.attempts[0].criteria.every((c) => c.passed)).toBe(true);
    expect(after.attempts[0].observation?.facts.titleLength).toBe(FIXED.length);
    expect(after.status).toBe("resolved");
    expect(after.resolvedAt).toBe(after.attempts[0].at);
    expect(after.originalObservation).toEqual(tracked.originalObservation);
    expect(after.finding).toEqual(tracked.finding);
  });

  it("still failing: the page still violates the criteria", async () => {
    const h = harness();
    const tracked = await h.trackTooLong();
    h.serve(() => page(html(LONG + " Extra")));

    const after = await verifyFinding(tracked.id, h.deps);

    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0].outcome).toBe("still_failing");
    expect(after.attempts[0].criteria).toEqual([expect.objectContaining({ id: "title.max-length", passed: false })]);
    expect(after.attempts[0].observation?.facts.titleText).toBe(LONG + " Extra");
    expect(after.status).toBe("open");
    expect(after.originalObservation).toEqual(tracked.originalObservation);
  });

  it("inconclusive: the fetch fails, so nothing is decided", async () => {
    const h = harness();
    const tracked = await h.trackTooLong();
    h.serve(() => {
      throw new SafeFetchError("TIMEOUT", "The page did not respond within 10s.");
    });

    const after = await verifyFinding(tracked.id, h.deps);

    expect(after.attempts).toHaveLength(1);
    expect(after.attempts[0]).toMatchObject({ outcome: "inconclusive", observation: null, error: { code: "TIMEOUT" } });
    expect(after.attempts[0].criteria).toEqual([]);
    expect(after.status).toBe("open");
    expect(after.originalObservation).toEqual(tracked.originalObservation);
  });
});

describe("status rules", () => {
  it("records every attempt in order and keeps the original observation", async () => {
    const h = harness();
    const tracked = await h.trackTooLong();
    h.serve(() => page(html(LONG)));
    await verifyFinding(tracked.id, h.deps);
    h.serve(() => {
      throw new SafeFetchError("HTTP_ERROR", "The page responded with HTTP 503.", 503);
    });
    await verifyFinding(tracked.id, h.deps);
    h.serve(() => page(html(FIXED)));
    const after = await verifyFinding(tracked.id, h.deps);

    expect(after.attempts.map((a) => a.outcome)).toEqual(["still_failing", "inconclusive", "resolved"]);
    expect(new Set(after.attempts.map((a) => a.id)).size).toBe(3);
    expect(after.originalObservation).toEqual(tracked.originalObservation);
  });

  it("an inconclusive re-check leaves a resolved finding resolved", async () => {
    const h = harness();
    const tracked = await h.trackTooLong();
    h.serve(() => page(html(FIXED)));
    await verifyFinding(tracked.id, h.deps);
    h.serve(() => {
      throw new SafeFetchError("NETWORK", "down");
    });
    const after = await verifyFinding(tracked.id, h.deps);
    expect(after.status).toBe("resolved");
  });

  it("a failing re-check reopens a resolved finding (regression)", async () => {
    const h = harness();
    const tracked = await h.trackTooLong();
    h.serve(() => page(html(FIXED)));
    await verifyFinding(tracked.id, h.deps);
    h.serve(() => page(html(LONG)));
    const after = await verifyFinding(tracked.id, h.deps);
    expect(after.status).toBe("open");
    expect(after.resolvedAt).toBeNull();
  });

  it("is inconclusive when the URL now redirects to a different page", async () => {
    const h = harness();
    const tracked = await h.trackTooLong();
    h.serve(() => page(html(FIXED), { finalUrl: "https://shop.example.com/" }));
    const after = await verifyFinding(tracked.id, h.deps);
    expect(after.attempts[0].outcome).toBe("inconclusive");
    expect(after.status).toBe("open");
  });

  it("is inconclusive when the page was truncated", async () => {
    const h = harness();
    const tracked = await h.trackTooLong();
    h.serve(() => page(html(FIXED), { truncated: true }));
    expect((await verifyFinding(tracked.id, h.deps)).attempts[0].outcome).toBe("inconclusive");
  });

  it("is inconclusive on an unexpected error rather than throwing", async () => {
    const h = harness();
    const tracked = await h.trackTooLong();
    h.serve(() => {
      throw new Error("boom");
    });
    const after = await verifyFinding(tracked.id, h.deps);
    expect(after.attempts[0]).toMatchObject({ outcome: "inconclusive", error: { code: "INTERNAL" } });
  });

  it("judges against the criteria frozen at creation, not expectations edited later", async () => {
    const h = harness();
    await setExpectations(PAGE_URL, { canonicalUrl: PAGE_URL }, h.deps);
    h.serve(() => page(html(FIXED).replace("</head>", `<link rel="canonical" href="${PAGE_URL}?ref=1"></head>`)));
    const audit = await runAudit({ url: PAGE_URL }, h.deps);
    const tracked = await trackFinding(audit.id, "canonical/expected-url", h.deps);

    // Owner later changes the expectation to match the current (unchanged) page.
    await setExpectations(PAGE_URL, { canonicalUrl: `${PAGE_URL}?ref=1` }, h.deps);
    const after = await verifyFinding(tracked.id, h.deps);
    expect(after.attempts[0].outcome).toBe("still_failing");
  });

  it("tracking the same open finding twice returns the same record", async () => {
    const h = harness();
    const a = await h.trackTooLong();
    const b = await h.trackTooLong();
    expect(b.id).toBe(a.id);
  });
});

describe("sample site", () => {
  it("demonstrates all three outcomes and never touches the live fetcher", async () => {
    const h = harness();
    h.serve(() => {
      throw new Error("live fetcher must not be used for sample findings");
    });
    const audit = await runAudit({ sample: true }, h.deps);
    expect(audit.source).toBe("sample");
    const tracked = await trackFinding(audit.id, "title/multiple", h.deps);

    expect((await verifyFinding(tracked.id, h.deps)).attempts.at(-1)?.outcome).toBe("still_failing");
    await setSampleState("fixed", h.deps);
    expect((await verifyFinding(tracked.id, h.deps)).status).toBe("resolved");
    await setSampleState("offline", h.deps);
    const after = await verifyFinding(tracked.id, h.deps);
    expect(after.attempts.map((a) => a.outcome)).toEqual(["still_failing", "resolved", "inconclusive"]);
    expect(after.status).toBe("resolved");
  });

  it("asks for expectations instead of guessing canonical and indexability", async () => {
    const h = harness();
    const audit = await runAudit({ sample: true }, h.deps);
    const byId = Object.fromEntries(audit.rules.map((r) => [r.ruleId, r]));
    expect(byId.canonical).toMatchObject({ status: "needs_config", findings: [], missingExpectations: ["canonicalUrl"] });
    expect(byId.indexability).toMatchObject({ status: "needs_config", findings: [], missingExpectations: ["indexability"] });
  });
});

describe("errors", () => {
  it("rejects tracking a finding that is not in the stored audit", async () => {
    const h = harness();
    const audit = await runAudit({ url: PAGE_URL }, h.deps);
    await expect(trackFinding(audit.id, "title/missing", h.deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(trackFinding("nope", "title/too-long", h.deps)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("rejects invalid expectations", async () => {
    const h = harness();
    await expect(setExpectations(PAGE_URL, { canonicalUrl: "/relative" }, h.deps)).rejects.toMatchObject({ code: "INVALID" });
    await expect(setExpectations(PAGE_URL, { indexability: "maybe" }, h.deps)).rejects.toMatchObject({ code: "INVALID" });
  });
});
