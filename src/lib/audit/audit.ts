import { safeFetchHtml } from "../fetch/safe-fetch";
import { SAMPLE_HTML, SAMPLE_URL } from "../sample/sample-page";
import { runRules } from "./run";
import type { AuditResult } from "./types";

/** Live audit: fetch a public URL, then run the deterministic rules on the returned HTML. */
export async function auditUrl(input: string): Promise<AuditResult> {
  const page = await safeFetchHtml(input);
  return {
    source: "live",
    requestedUrl: page.requestedUrl,
    finalUrl: page.finalUrl,
    httpStatus: page.status,
    redirectChain: page.redirectChain,
    fetchedAt: new Date().toISOString(),
    bytes: page.bytes,
    truncated: page.truncated,
    rules: runRules(page.html),
  };
}

/** Sample audit: same rules, bundled fixture HTML, clearly labelled as sample. */
export function auditSample(): AuditResult {
  return {
    source: "sample",
    requestedUrl: SAMPLE_URL,
    finalUrl: SAMPLE_URL,
    httpStatus: 200,
    redirectChain: [],
    fetchedAt: new Date().toISOString(),
    bytes: new TextEncoder().encode(SAMPLE_HTML).byteLength,
    truncated: false,
    rules: runRules(SAMPLE_HTML),
  };
}
