"use client";
import { useCallback, useEffect, useRef, useState } from "react";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

/** JSON request that throws ApiError with the server's actionable message. */
export async function api<T>(url: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: init?.signal,
      cache: "no-store",
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError(0, "OFFLINE", "Could not reach the SiteSentry server. Check that it is running and try again.");
  }
  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok) {
    const err = (json as { error?: { code: string; message: string; details?: Record<string, unknown> } } | null)?.error;
    throw new ApiError(res.status, err?.code ?? "HTTP_" + res.status, err?.message ?? `The server responded with HTTP ${res.status}.`, err?.details);
  }
  return json as T;
}

export interface Resource<T> {
  data: T | null;
  error: ApiError | null;
  loading: boolean;
  /** Re-fetch; keeps showing the previous data meanwhile. */
  reload: () => Promise<void>;
  setData: (d: T) => void;
}

// Requests started ahead of the component that reads them (a view that knows which request its child screen makes
// next). The first useApi load of the same URL within PREFETCH_TTL_MS takes the promise instead of fetching again.
// Short, so a screen that mounts later (an audit that finishes while its page is open) fetches fresh data.
const PREFETCH_TTL_MS = 5_000;
const prefetched = new Map<string, { at: number; promise: Promise<unknown> }>();

/** Starts a GET now so a screen mounted later does not wait on a request chain. Failures surface to that screen. */
export function prefetchApi(url: string): void {
  if (prefetched.has(url)) return;
  const promise = api(url);
  promise.catch(() => undefined);
  prefetched.set(url, { at: Date.now(), promise });
}

function takePrefetched<T>(url: string): Promise<T> | null {
  const p = prefetched.get(url);
  if (!p) return null;
  prefetched.delete(url);
  return Date.now() - p.at <= PREFETCH_TTL_MS ? (p.promise as Promise<T>) : null;
}

/** Fetch JSON for a view. `url = null` skips the request. Data from a previous URL is never shown for a new one. */
export function useApi<T>(url: string | null): Resource<T> {
  const [state, setState] = useState<{ url: string | null; data: T | null; error: ApiError | null; loading: boolean }>({ url, data: null, error: null, loading: !!url });
  const ctrl = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    if (!url) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setState((s) => (s.url === url ? { ...s, loading: true } : { url, data: null, error: null, loading: true }));
    try {
      const d = await (takePrefetched<T>(url) ?? api<T>(url, { signal: c.signal }));
      if (!c.signal.aborted) setState({ url, data: d, error: null, loading: false });
    } catch (e) {
      if ((e as Error).name === "AbortError" || c.signal.aborted) return;
      const err = e instanceof ApiError ? e : new ApiError(0, "INTERNAL", (e as Error).message);
      setState((s) => ({ url, data: s.url === url ? s.data : null, error: err, loading: false }));
    }
  }, [url]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- starting a fetch is syncing with an external system; load() only flags it as in flight
    void load();
    return () => ctrl.current?.abort();
  }, [load]);

  const current = state.url === url ? state : { url, data: null, error: null, loading: !!url };
  const setData = useCallback((d: T) => setState({ url, data: d, error: null, loading: false }), [url]);
  return { data: current.data, error: current.error, loading: current.loading, reload: load, setData };
}
