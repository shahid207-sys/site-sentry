// Stable finding identity across audits (docs/SPEC.md "Phase 3" item 3): hash(rule id, normalised URL, evidence key).
// The rule version, message, confidence and every count or sample in the evidence are left out, so a finding whose
// wording or numbers change between audits is the same issue, and a fixed one is gone, not renamed.
import { createHash } from "node:crypto";
import { normaliseUrl } from "../crawl/normalise";
import type { Finding, Rule } from "./contract";

export function evidenceKey(rule: Pick<Rule, "evidenceKey"> | undefined, f: Finding): string {
  const k = rule?.evidenceKey ? rule.evidenceKey(f) : f.evidence.groupKey;
  // Postgres stores no NUL in text or jsonb: one in a key would fail the whole analysis, so it never leaves here.
  return k === undefined || k === null ? "" : String(k).replaceAll("\u0000", " ");
}

export function findingFingerprint(ruleId: string, url: string, key: string): string {
  const n = normaliseUrl(url);
  return createHash("sha256")
    .update([ruleId, n.ok ? n.url : url, key].join("\u0000"))
    .digest("hex")
    .slice(0, 24);
}

/** A finding's fingerprint and the evidence key it was built from. */
export function fingerprintOf(rule: Pick<Rule, "evidenceKey"> | undefined, f: Finding): { fingerprint: string; key: string } {
  const key = evidenceKey(rule, f);
  return { fingerprint: findingFingerprint(f.ruleId, f.url, key), key };
}
