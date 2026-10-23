import type { AuditResult, PageExpectations, TrackedFinding } from "@/lib/audit/types";
import type { SampleState } from "@/lib/sample/sample-page";

export interface ApiError {
  code: string;
  message: string;
}

export class ApiRequestError extends Error {
  constructor(public error: ApiError) {
    super(error.message);
  }
}

async function call<T>(url: string, init?: { method?: string; body?: unknown }): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: init?.body !== undefined ? { "content-type": "application/json" } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
    });
  } catch {
    throw new ApiRequestError({ code: "NETWORK", message: "Could not reach the Site Sentry server." });
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new ApiRequestError(data?.error ?? { code: "UNKNOWN", message: `Request failed (${res.status}).` });
  return data as T;
}

export const api = {
  audit: (body: { url: string } | { sample: true }) => call<AuditResult>("/api/audit", { method: "POST", body }),
  listFindings: () => call<TrackedFinding[]>("/api/findings"),
  track: (auditId: string, ruleCode: string) =>
    call<TrackedFinding>("/api/findings", { method: "POST", body: { auditId, ruleCode } }),
  verify: (id: string) => call<TrackedFinding>(`/api/findings/${encodeURIComponent(id)}/verify`, { method: "POST" }),
  setExpectations: (pageUrl: string, exp: PageExpectations) =>
    call<PageExpectations>("/api/expectations", { method: "PUT", body: { pageUrl, ...exp } }),
  getSampleState: () => call<{ state: SampleState }>("/api/sample-state"),
  setSampleState: (state: SampleState) => call<{ state: SampleState }>("/api/sample-state", { method: "PUT", body: { state } }),
};
