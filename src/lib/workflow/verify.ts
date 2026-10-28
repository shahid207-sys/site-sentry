import { evaluateCriteria } from "../audit/rule";
import { CRITERION_EVALUATORS, pageContext, ruleById } from "../audit/run";
import { siteRuleById } from "../audit/site";
import { inconclusive, type VerifyBody, type VerifyEnv } from "../audit/site/types";
import type { ItemVerification, Observation } from "../audit/types";
import { normalizePageUrl } from "../crawl/url";
import { SafeFetchError, type FetchResult } from "../fetch/safe-fetch";
import type { TaskItem, TaskVerification, VerificationStatus } from "../model";

/**
 * Pure and deterministic: judge a fresh response against the finding's ORIGINAL stored acceptance criteria.
 * No LLM, no heuristics beyond the stored criteria.
 */
export function evaluatePageAttempt(item: TaskItem, res: FetchResult, env: Pick<VerifyEnv, "config" | "now" | "source">): VerifyBody {
  const { finding, originalObservation } = item;
  const rule = ruleById(finding.ruleId);
  if (!rule) return inconclusive(`Rule "${finding.ruleId}" no longer exists, so this finding cannot be judged.`);

  const html = res.status >= 200 && res.status < 300 && res.contentTypeAccepted ? res.body : null;
  const finalUrl = normalizePageUrl(res.finalUrl) ?? res.finalUrl;
  const ctx = pageContext(
    {
      html,
      pageUrl: finalUrl,
      headers: res.headers,
      response: { requestedUrl: finding.pageUrl, finalUrl, status: res.status, redirectChain: res.redirectChain, contentType: res.contentType },
    },
    env.config,
  );

  if (!rule.judgesResponse) {
    // Content rules can only judge the same, complete, successfully served document.
    if (html === null) {
      return inconclusive(
        res.status >= 200 && res.status < 300
          ? `The URL now serves "${res.contentType || "no content type"}", not HTML, so the page could not be checked.`
          : `The page responded with HTTP ${res.status}, so its content could not be checked.`,
      );
    }
  }
  const { facts, snippets } = rule.observe(ctx as never);
  const observation: Observation = { capturedAt: env.now().toISOString(), source: env.source, finalUrl, httpStatus: res.status, facts, snippets };

  if (!rule.judgesResponse) {
    if (finalUrl !== (normalizePageUrl(originalObservation.finalUrl) ?? originalObservation.finalUrl)) {
      return { ...inconclusive(`The URL now redirects to ${finalUrl}, a different page from the one originally audited (${originalObservation.finalUrl}).`), observation };
    }
    if (res.truncated) return { ...inconclusive("The page was larger than the 2 MB limit, so the full document could not be checked."), observation };
  }

  const { results, unknown } = evaluateCriteria(finding.acceptanceCriteria, facts, CRITERION_EVALUATORS);
  if (unknown.length) return { ...inconclusive(`No evaluator for criteria: ${unknown.join(", ")}.`), criteria: results, observation };
  if (results.length === 0) return { ...inconclusive("The finding has no acceptance criteria to check."), observation };

  const failed = results.filter((r) => !r.passed);
  return failed.length === 0
    ? { outcome: "resolved", reason: `All ${results.length} acceptance criteria passed.`, criteria: results, observation }
    : {
        outcome: "still_failing",
        reason: `${failed.length} of ${results.length} acceptance criteria still fail: ${failed.map((f) => f.description).join("; ")}.`,
        criteria: results,
        observation,
      };
}

/** Re-check one task item. Never throws: failures to observe are inconclusive. */
export async function verifyItem(item: TaskItem, env: VerifyEnv): Promise<ItemVerification> {
  const { finding } = item;
  let body: VerifyBody;
  try {
    if (finding.verify === "reaudit") {
      body = inconclusive("This finding depends on the whole crawl (e.g. the internal link graph). Run a new audit to re-check it.");
    } else if (finding.verify === "site") {
      const rule = siteRuleById(finding.ruleId);
      body = rule?.verify ? await rule.verify(finding, env) : inconclusive(`Rule "${finding.ruleId}" cannot be re-checked directly. Run a new audit.`);
    } else {
      const url = finding.scope.kind === "page" ? finding.scope.url : finding.pageUrl;
      const res = await env.fetch(url, { accept: "html" });
      body = evaluatePageAttempt(item, res, env);
    }
  } catch (e) {
    const error = e instanceof SafeFetchError ? { code: e.code, message: e.message } : { code: "INTERNAL", message: (e as Error)?.message ?? "Unexpected error" };
    // An http/error-status finding on a URL that now times out is still not fixed, but we cannot prove it either.
    body = inconclusive(`The page could not be checked: ${error.message}`, error);
  }
  return { fingerprint: item.fingerprint, ...body };
}

/** Combine item results into a task-level verification status. */
export function summarizeVerification(items: ItemVerification[]): { outcome: VerificationStatus; reason: string } {
  const n = items.length;
  const resolved = items.filter((i) => i.outcome === "resolved").length;
  const failing = items.filter((i) => i.outcome === "still_failing").length;
  const unknown = n - resolved - failing;
  if (n === 0) return { outcome: "inconclusive", reason: "Nothing to verify." };
  if (failing > 0) return { outcome: "failing", reason: `${failing} of ${n} item(s) still fail${unknown ? `; ${unknown} could not be checked` : ""}.` };
  if (resolved === n) return { outcome: "passing", reason: `All ${n} item(s) pass their acceptance criteria.` };
  if (resolved > 0) return { outcome: "partial", reason: `${resolved} of ${n} item(s) pass; ${unknown} could not be checked.` };
  return { outcome: "inconclusive", reason: items[0]?.reason ?? "Could not be checked." };
}

export type { TaskVerification };
