import type { CriterionEvaluator, RuleDef } from "../rule";
import { num } from "../rule";

export type HttpFacts = {
  httpStatus: number;
  redirectCount: number;
  requestedUrl: string;
  finalUrl: string;
  /** "301 → 302 → 200" style summary of the chain. */
  redirectSummary: string | null;
};

export const httpEvaluators: Record<string, CriterionEvaluator> = {
  "http.status-ok": (f) => {
    const s = num(f.httpStatus);
    return { passed: s !== null && s >= 200 && s < 300, actual: `HTTP ${s ?? "unknown"}` };
  },
  "http.max-redirects": (f, p) => {
    const n = num(f.redirectCount);
    return { passed: n !== null && n <= Number(p.max), actual: `${n ?? "unknown"} redirect(s)${f.redirectSummary ? `: ${f.redirectSummary}` : ""}` };
  },
};

const statusLabel = (s: number) => (s >= 500 ? "server error" : s === 404 || s === 410 ? "not found" : "client error");

export const httpRule: RuleDef<HttpFacts> = {
  id: "http",
  name: "HTTP response",
  category: "crawlability",
  requiresHtml: false,
  judgesResponse: true,
  subject: "requested",

  observe({ response }) {
    const chain = response.redirectChain;
    return {
      facts: {
        httpStatus: response.status,
        redirectCount: chain.length,
        requestedUrl: response.requestedUrl,
        finalUrl: response.finalUrl,
        redirectSummary: chain.length ? [...chain.map((h) => String(h.status)), String(response.status)].join(" → ") : null,
      },
      snippets: [
        ...chain.map((h) => `${h.status} ${h.url}`),
        `${response.status} ${response.finalUrl}${response.contentType ? `  (${response.contentType})` : ""}`,
      ],
    };
  },

  checks: [
    {
      code: "http/error-status",
      severity: "high",
      kind: "defect",
      certainty: "verified",
      why: "A page that returns an error status cannot be indexed, and links pointing to it lead visitors to an error.",
      detect: (f) => f.httpStatus >= 400,
      criteria: () => [{ id: "http.status-ok", description: "The URL responds with a 2xx status", params: {} }],
      describe: (f) => ({
        title: `URL returns HTTP ${f.httpStatus} (${statusLabel(f.httpStatus)})`,
        message: `Requesting ${f.requestedUrl} returned HTTP ${f.httpStatus}.`,
        observed: `HTTP ${f.httpStatus}${f.redirectSummary ? ` after ${f.redirectSummary}` : ""}`,
        expected: "HTTP 200 for a page that should exist, or a 301 to its replacement",
        recommendations:
          f.httpStatus >= 500
            ? ["Check server logs for this URL; a 5xx is a server-side failure.", "Re-check later to rule out a transient outage."]
            : [
                "If the page moved, add a permanent (301) redirect to its replacement.",
                "If it was removed on purpose, remove internal links and sitemap entries that point to it.",
              ],
        diagnosis: f.httpStatus >= 500 ? "Server errors can be transient; one observation does not prove a persistent outage." : undefined,
      }),
    },
    {
      code: "http/redirect-chain",
      severity: "medium",
      kind: "warning",
      certainty: "verified",
      why: "Each extra redirect hop adds latency and is another place for a redirect to break. Search engines may stop following long chains.",
      detect: (f) => f.redirectCount > 1,
      criteria: () => [{ id: "http.max-redirects", description: "The URL reaches its destination in at most 1 redirect", params: { max: 1 } }],
      describe: (f) => ({
        title: `Redirect chain of ${f.redirectCount} hops`,
        message: `${f.requestedUrl} reaches ${f.finalUrl} through ${f.redirectCount} redirects.`,
        observed: f.redirectSummary ?? `${f.redirectCount} redirects`,
        expected: "At most one redirect to the final URL",
        recommendations: ["Point the first redirect directly at the final URL.", "Update internal links to use the final URL."],
      }),
    },
    {
      code: "http/important-redirects",
      severity: "medium",
      kind: "warning",
      certainty: "verified",
      why: "An important URL that redirects means links and sitemaps point at an address that is not the page itself.",
      needs: ["important"],
      expectationKey: () => "important",
      detect: (f, exp) => exp.important === true && f.redirectCount >= 1 && f.httpStatus < 400,
      criteria: () => [{ id: "http.max-redirects", description: "The important URL responds without redirecting", params: { max: 0 } }],
      describe: (f) => ({
        title: "Important URL redirects",
        message: `${f.requestedUrl} is on the important-URL list but redirects to ${f.finalUrl}.`,
        observed: f.redirectSummary ?? "redirects",
        expected: "The configured URL responds 200 directly (or update the configured URL)",
        recommendations: [
          "If the redirect is intended, update the important-URL list to the destination URL.",
          "Otherwise remove the redirect so the configured URL serves the page.",
        ],
      }),
    },
  ],
};
