import type { AuditSource, RedirectHop } from "../audit/types";
import { SafeFetchError, safeFetchHtml } from "../fetch/safe-fetch";
import { SAMPLE_HTML_BROKEN, SAMPLE_HTML_FIXED, SAMPLE_URL, type SampleState } from "../sample/sample-page";

export interface FetchedPage {
  source: AuditSource;
  requestedUrl: string;
  finalUrl: string;
  status: number;
  redirectChain: RedirectHop[];
  html: string;
  bytes: number;
  truncated: boolean;
  headers: Record<string, string>;
}

/** Fetches a live page. Throws SafeFetchError on any failure. */
export type LiveFetcher = (url: string) => Promise<FetchedPage>;

export const fetchLivePage: LiveFetcher = async (url) => ({ source: "live", ...(await safeFetchHtml(url)) });

/** The simulated sample site. "offline" fails exactly like an unreachable live site. */
export function fetchSamplePage(state: SampleState): FetchedPage {
  if (state === "offline") {
    throw new SafeFetchError("NETWORK", "SAMPLE: the simulated site is offline.");
  }
  const html = state === "fixed" ? SAMPLE_HTML_FIXED : SAMPLE_HTML_BROKEN;
  return {
    source: "sample",
    requestedUrl: SAMPLE_URL,
    finalUrl: SAMPLE_URL,
    status: 200,
    redirectChain: [],
    html,
    bytes: new TextEncoder().encode(html).byteLength,
    truncated: false,
    headers: { "content-type": "text/html; charset=utf-8" },
  };
}
