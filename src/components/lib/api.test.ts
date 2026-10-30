import { afterEach, describe, expect, it, vi } from "vitest";
import { prefetchApi, takePrefetched } from "./api";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A fetch whose responses resolve when `release()` is called, counting calls. */
function slowFetch() {
  const calls: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  vi.stubGlobal("fetch", async (url: string) => {
    calls.push(url);
    await gate;
    return new Response(JSON.stringify({ url }), { status: 200 });
  });
  return { calls, release: () => release() };
}

describe("prefetchApi", () => {
  it("hands a slow pending request to the first reader, however long it has been running", async () => {
    vi.useFakeTimers();
    const f = slowFetch();
    prefetchApi("/api/a");
    vi.advanceTimersByTime(30_000);
    prefetchApi("/api/a");
    const p = takePrefetched<{ url: string }>("/api/a");
    expect(p).not.toBeNull();
    f.release();
    await expect(p).resolves.toEqual({ url: "/api/a" });
    expect(f.calls).toEqual(["/api/a"]);
    expect(takePrefetched("/api/a")).toBeNull();
  });

  it("drops a response that settled more than 5 s ago, and a new prefetch replaces it", async () => {
    vi.useFakeTimers();
    const f = slowFetch();
    f.release();
    prefetchApi("/api/b");
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(5_001);
    prefetchApi("/api/b");
    expect(f.calls).toEqual(["/api/b", "/api/b"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(takePrefetched("/api/b")).not.toBeNull();

    prefetchApi("/api/c");
    await vi.advanceTimersByTimeAsync(0);
    vi.advanceTimersByTime(5_001);
    expect(takePrefetched("/api/c")).toBeNull();
  });
});
