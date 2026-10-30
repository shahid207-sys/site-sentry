// Regression alert of a scheduled audit (docs/SPEC.md Phase 6: "scheduled audits with ... webhook regression alerts").
// Built from the comparison of the scheduled audit with the previous analysed audit of the site (compareCrawls), so
// its numbers are the Compare screen's. An alert is sent only when something got worse: an issue group that is new
// or regressed. Resolved and not-re-checked groups alone never alert.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Comparison, GroupChange } from "../results/queries";

export const ALERT_EVENT = "audit.regression";
/** Header carrying the HMAC-SHA256 of the raw body, as "sha256=<hex>". */
export const SIGNATURE_HEADER = "x-sitesentry-signature";
const WORSE: GroupChange[] = ["regressed", "new"];

export interface RegressionAlert {
  event: typeof ALERT_EVENT;
  site: { id: string; name: string; origin: string };
  scheduleId: string;
  audit: { id: string; crawlId: string; createdAt: string; url: string | null };
  base: { crawlId: string; createdAt: string };
  health: { before: number | null; after: number | null };
  /** Groups per change (every group, not only the ones listed). */
  totals: Record<GroupChange, number>;
  /** The new and regressed groups, regressed first, then most fingerprints. */
  groups: { ruleId: string; change: GroupChange; fingerprints: number }[];
  /** Set when the two audits covered noticeably different parts of the site (the comparison says why). */
  warnings: string[];
}

export interface AlertContext {
  scheduleId: string;
  site: { id: string; name: string; origin: string };
  auditId: string;
  /** Link to the audit's Compare screen, when the app's public URL is known. */
  url: string | null;
}

/** The alert for a comparison, or null when nothing got worse. */
export function regressionAlert(cmp: Comparison, ctx: AlertContext): RegressionAlert | null {
  const worse = cmp.groups.filter((g) => WORSE.includes(g.change));
  if (!worse.length) return null;
  const fingerprints = (g: (typeof worse)[number]) => (g.counts[g.change] ?? 0);
  const groups = worse
    .map((g) => ({ ruleId: g.ruleId, change: g.change, fingerprints: fingerprints(g) }))
    .sort((a, b) => WORSE.indexOf(a.change) - WORSE.indexOf(b.change) || b.fingerprints - a.fingerprints || (a.ruleId < b.ruleId ? -1 : 1));
  return {
    event: ALERT_EVENT,
    site: ctx.site,
    scheduleId: ctx.scheduleId,
    audit: { id: ctx.auditId, crawlId: cmp.head.crawlId, createdAt: cmp.head.createdAt, url: ctx.url },
    base: { crawlId: cmp.base.crawlId, createdAt: cmp.base.createdAt },
    health: { before: cmp.base.health?.score ?? null, after: cmp.head.health?.score ?? null },
    totals: cmp.totals,
    groups,
    warnings: cmp.warnings,
  };
}

export const signBody = (body: string, secret: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

/** For receivers: whether `signature` is this body's signature with `secret` (constant-time). */
export function verifySignature(body: string, secret: string, signature: string | null | undefined): boolean {
  if (!signature) return false;
  const a = Buffer.from(signBody(body, secret));
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}
