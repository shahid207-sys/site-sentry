import { createHash } from "node:crypto";
import { normalizePageUrl, originOf } from "../crawl/url";
import type { Finding } from "./types";

/**
 * Stable issue identity: rule code + normalised page identity + the expectation that shaped it.
 * Wording, severity and observed values are deliberately excluded, so a finding whose observed value
 * changes is the same issue, and two unrelated findings with identical text are not.
 */
export function fingerprintParts(f: Finding): string[] {
  const origin = originOf(f.pageUrl) ?? "";
  let identity: string;
  switch (f.scope.kind) {
    case "page":
      identity = `page:${normalizePageUrl(f.scope.url) ?? f.scope.url}`;
      break;
    case "target":
      identity = `target:${normalizePageUrl(f.scope.url) ?? f.scope.url}`;
      break;
    case "pages":
      identity = `group:${origin}`;
      break;
    case "site":
      identity = `site:${origin}:${f.scope.check}`;
      break;
  }
  return [f.ruleCode, identity, f.expectationKey ?? ""];
}

export function fingerprintOf(f: Finding): string {
  return createHash("sha256").update(fingerprintParts(f).join("\u0000")).digest("hex").slice(0, 20);
}
