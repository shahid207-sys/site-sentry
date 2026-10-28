// The homepage product preview: one real finding from the sample fixtures, produced by the actual rule
// engine, plus the same acceptance criteria judged against the fixture's fixed version. Pure, no network.
import { evaluateCriteria } from "../audit/rule";
import { CRITERION_EVALUATORS, runRules } from "../audit/run";
import type { CriterionResult, Finding } from "../audit/types";
import { fixtureSites, renderPage } from "./fixtures";

const PATH = "/tents/alpine-2p";
const CODE = "canonical/expected-url";

export interface ProductPreviewData {
  siteName: string;
  pageUrl: string;
  finding: Pick<Finding, "ruleCode" | "title" | "severity" | "kind" | "certainty" | "observed" | "expected" | "why" | "recommendations" | "acceptanceCriteria"> & { snippet: string | null };
  before: CriterionResult[];
  after: CriterionResult[];
}

function inspect(state: "original" | "fixed") {
  const site = fixtureSites(state)[0];
  const page = site.pages.find((p) => p.path === PATH);
  if (!page) throw new Error(`Sample fixture ${PATH} is missing`);
  const pageUrl = `${site.origin}${PATH}`;
  const results = runRules({ html: renderPage(site, page), pageUrl }, { canonicalUrl: pageUrl, indexability: "index", important: true });
  return { site, pageUrl, results };
}

export function buildProductPreview(): ProductPreviewData {
  const before = inspect("original");
  const f = before.results.flatMap((r) => r.findings).find((x) => x.ruleCode === CODE);
  if (!f) throw new Error(`Sample fixture no longer produces ${CODE}`);
  const after = inspect("fixed");
  const factsOf = (rs: typeof before.results) => rs.find((r) => r.ruleId === f.ruleId)?.facts ?? {};
  return {
    siteName: before.site.name,
    pageUrl: before.pageUrl,
    finding: {
      ruleCode: f.ruleCode,
      title: f.title,
      severity: f.severity,
      kind: f.kind,
      certainty: f.certainty,
      observed: f.observed,
      expected: f.expected,
      why: f.why,
      recommendations: f.recommendations,
      acceptanceCriteria: f.acceptanceCriteria,
      snippet: f.evidence.snippets[0] ?? null,
    },
    before: evaluateCriteria(f.acceptanceCriteria, factsOf(before.results), CRITERION_EVALUATORS).results,
    after: evaluateCriteria(f.acceptanceCriteria, factsOf(after.results), CRITERION_EVALUATORS).results,
  };
}
