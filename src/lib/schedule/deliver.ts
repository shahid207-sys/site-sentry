// After a scheduled audit is analysed: compare it with the site's previous analysed audit and, when something got
// worse, POST the signed regression alert to the schedule's webhook. Runs in the analysis worker, once per crawl:
// every outcome (sent, failed, skipped) is recorded in alert_deliveries, unique per (schedule, crawl), so a retried
// analysis job never alerts twice. The request goes through the crawler's SSRF guard: the webhook host is resolved
// once, refused when it is private or reserved, and the socket is pinned to the vetted address.
import { fetch } from "undici";
import { secretKey, decryptSecret } from "../crawl/v2/secrets";
import type { Db } from "../db/client";
import { DEFAULT_POLICY, pinnedAgent, resolvePinned, validateTargetUrl, type FetchPolicy } from "../fetch/safe-fetch";
import { compareCrawls } from "../results/queries";
import { previousAudit } from "../results/states";
import { regressionAlert, signBody, SIGNATURE_HEADER, type RegressionAlert } from "./alert";
import { deliveryExists, recordDelivery, scheduleOfCrawl, scheduleWebhook } from "./store";

export const MAX_ATTEMPTS = 3;
const TIMEOUT_MS = 10_000;

export interface DeliverOptions {
  policy?: FetchPolicy;
  log?: (event: string, data?: Record<string, unknown>) => void;
  /** Public base URL of the app (APP_URL), for the link in the alert. */
  appUrl?: string | null;
  /** Wait between attempts; tests pass 0. */
  backoffMs?: number;
  env?: Record<string, string | undefined>;
}

export type DeliveryOutcome = { status: "none" } | { status: "sent" | "failed" | "skipped"; detail: string; alert: RegressionAlert | null };

/** The webhook secret's encryption scope: a ciphertext copied to another schedule does not decrypt. */
export const webhookScope = (scheduleId: string) => `webhook:${scheduleId}`;

export async function afterAnalysed(db: Db, crawlId: string, opts: DeliverOptions = {}): Promise<DeliveryOutcome> {
  const log = opts.log ?? (() => undefined);
  const owner = await scheduleOfCrawl(db, crawlId);
  if (!owner) return { status: "none" };
  if (await deliveryExists(db, owner.scheduleId, crawlId)) return { status: "none" };
  const record = async (status: "sent" | "failed" | "skipped", detail: string, extra: { base?: string | null; httpStatus?: number | null; attempts?: number; alert?: RegressionAlert | null } = {}) => {
    await recordDelivery(db, {
      scheduleId: owner.scheduleId,
      crawlId,
      baseCrawlId: extra.base ?? null,
      status,
      httpStatus: extra.httpStatus ?? null,
      attempts: extra.attempts ?? 0,
      detail,
      payload: extra.alert ?? null,
    });
    log("schedule.alert", { scheduleId: owner.scheduleId, crawlId, status, detail });
    return { status, detail, alert: extra.alert ?? null } as const;
  };

  const base = await previousAudit(db, crawlId);
  if (!base) return record("skipped", "First analysed audit of this site: nothing to compare with yet.");
  const cmp = await compareCrawls(db, base, crawlId);
  const origin = cmp.head.siteOrigin;
  const appUrl = opts.appUrl?.replace(/\/+$/, "");
  const alert = regressionAlert(cmp, {
    scheduleId: owner.scheduleId,
    site: { id: owner.siteId, name: new URL(origin).host, origin },
    auditId: owner.auditId,
    url: appUrl ? `${appUrl}/${owner.workspace}/audits/${owner.auditId}/compare?base=${base}` : null,
  });
  if (!alert) return record("skipped", "No new or regressed issue groups.", { base });

  const hook = await scheduleWebhook(db, owner.scheduleId);
  if (!hook) return record("skipped", "Regression found; the schedule has no webhook.", { base, alert });
  const key = secretKey(opts.env);
  if (!key) return record("failed", "CRAWLER_SECRET_KEY is not set, so the webhook secret cannot be decrypted.", { base, alert });
  let secret: string;
  try {
    secret = decryptSecret(hook.secret, key, webhookScope(owner.scheduleId));
  } catch {
    return record("failed", "The webhook secret could not be decrypted (CRAWLER_SECRET_KEY changed?).", { base, alert });
  }

  const body = JSON.stringify(alert);
  const policy = opts.policy ?? DEFAULT_POLICY;
  let last = { detail: "", httpStatus: null as number | null };
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const status = await post(hook.url, body, signBody(body, secret), policy);
      if (status >= 200 && status < 300) return record("sent", `Delivered (HTTP ${status}).`, { base, httpStatus: status, attempts: attempt, alert });
      last = { detail: `The webhook answered HTTP ${status}.`, httpStatus: status };
      // A 4xx other than 408/429 will not change on retry.
      if (status >= 400 && status < 500 && status !== 408 && status !== 429) return record("failed", last.detail, { base, httpStatus: status, attempts: attempt, alert });
    } catch (e) {
      last = { detail: (e as Error).message.slice(0, 300), httpStatus: null };
      if ((e as { code?: string }).code === "BLOCKED_HOST" || (e as { code?: string }).code === "INVALID_URL") {
        return record("failed", last.detail, { base, attempts: attempt, alert });
      }
    }
    if (attempt < MAX_ATTEMPTS) await new Promise((r) => setTimeout(r, (opts.backoffMs ?? 2_000) * attempt));
  }
  return record("failed", `${last.detail} (after ${MAX_ATTEMPTS} attempts)`, { base, httpStatus: last.httpStatus, attempts: MAX_ATTEMPTS, alert });
}

/** One POST, never following redirects (a redirect could point the alert at an unvetted host). */
async function post(target: string, body: string, signature: string, policy: FetchPolicy): Promise<number> {
  const url = validateTargetUrl(target, policy);
  const [ip] = await resolvePinned(url, policy);
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "SiteSentry-Webhook/1", [SIGNATURE_HEADER]: signature },
    body,
    redirect: "manual",
    dispatcher: pinnedAgent(url.hostname, ip, policy.ca),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  await res.body?.cancel();
  return res.status;
}
