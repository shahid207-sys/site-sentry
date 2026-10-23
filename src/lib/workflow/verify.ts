import { normaliseUrl } from "../audit/rules/canonical";
import { evaluateCriteria } from "../audit/rule";
import { CRITERION_EVALUATORS, ruleById } from "../audit/run";
import { parseHtml } from "../audit/parse";
import type { Observation, TrackedFinding, VerificationAttempt } from "../audit/types";
import type { FetchedPage } from "./pages";

type AttemptBody = Omit<VerificationAttempt, "id" | "at">;

const inconclusive = (reason: string, observation: Observation | null = null, error?: AttemptBody["error"]): AttemptBody => ({
  outcome: "inconclusive",
  reason,
  criteria: [],
  observation,
  error,
});

/** The page could not be observed: never resolved, never still-failing. */
export function inconclusiveFromError(error: { code: string; message: string }): AttemptBody {
  return inconclusive(`The page could not be checked: ${error.message}`, null, error);
}

/**
 * Pure and deterministic: judge a fresh page against the finding's ORIGINAL stored acceptance criteria.
 * No LLM, no heuristics beyond the stored criteria.
 */
export function evaluateAttempt(tracked: TrackedFinding, page: FetchedPage, capturedAt: string): AttemptBody {
  const { finding, originalObservation } = tracked;
  const rule = ruleById(finding.ruleId);
  if (!rule) return inconclusive(`Rule "${finding.ruleId}" no longer exists, so this finding cannot be judged.`);

  const { facts, snippets } = rule.observe({
    $: parseHtml(page.html),
    pageUrl: page.finalUrl,
    headers: page.headers,
  });
  const observation: Observation = {
    capturedAt,
    source: page.source,
    finalUrl: page.finalUrl,
    httpStatus: page.status,
    facts,
    snippets,
  };

  if (normaliseUrl(page.finalUrl) !== normaliseUrl(originalObservation.finalUrl)) {
    return inconclusive(
      `The URL now redirects to ${page.finalUrl}, a different page from the one originally audited (${originalObservation.finalUrl}).`,
      observation,
    );
  }
  if (page.truncated) {
    return inconclusive("The page was larger than the 2 MB limit, so the full document could not be checked.", observation);
  }

  const { results, unknown } = evaluateCriteria(finding.acceptanceCriteria, facts, CRITERION_EVALUATORS);
  if (unknown.length) {
    return { ...inconclusive(`No evaluator for criteria: ${unknown.join(", ")}.`, observation), criteria: results };
  }
  if (results.length === 0) return inconclusive("The finding has no acceptance criteria to check.", observation);

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

/**
 * The only way a tracked finding's status changes.
 * - resolved      → status resolved
 * - still_failing → status open (a previously resolved finding is reopened as a regression)
 * - inconclusive  → status unchanged
 * The original finding and observation are never modified.
 */
export function applyAttempt(tracked: TrackedFinding, attempt: VerificationAttempt): TrackedFinding {
  const next: TrackedFinding = { ...tracked, attempts: [...tracked.attempts, attempt] };
  if (attempt.outcome === "resolved") {
    next.status = "resolved";
    next.resolvedAt = attempt.at;
  } else if (attempt.outcome === "still_failing") {
    next.status = "open";
    next.resolvedAt = null;
  }
  return next;
}
