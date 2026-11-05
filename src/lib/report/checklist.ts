// The report's technical checklist. Each row is a set of rules, and its status comes only from how those rules ran
// in this crawl. Pass needs every rule to have run on something with nothing found: a rule that did not run, or that
// had nothing to evaluate, makes the row "Not checked", never Pass. The hreflang row also reads the site's languages:
// it passes only when hreflang exists, fails when several languages have none, and does not apply to a one-language site.
import type { IssueGroupRow, RuleRunRow } from "../results/queries";

export type ChecklistStatus = "Pass" | "Fail" | "Warning" | "Not checked" | "Not applicable";

/** The languages the analysis detected (each with enough pages), and the pages that carry hreflang. */
export interface SiteLanguages {
  detected: { language: string; pages: number }[];
  hreflangPages: number;
}

const HREFLANG = "hreflang";

const r = (prefix: string, ...ns: number[]) => ns.map((n) => `${prefix}-${String(n).padStart(3, "0")}`);
const span = (prefix: string, from: number, to: number) => r(prefix, ...Array.from({ length: to - from + 1 }, (_, i) => from + i));

export const CHECKLIST: { label: string; rules: string[] }[] = [
  { label: "Internal URLs answer without errors", rules: r("IDX", 1, 2, 19) },
  { label: "Redirects are clean and permanent", rules: span("IDX", 3, 6) },
  { label: "robots.txt reachable and not over-blocking", rules: r("IDX", 7, 25, 26) },
  { label: "noindex used consistently", rules: span("IDX", 8, 10) },
  { label: "Canonical tags", rules: span("IDX", 11, 18) },
  { label: "One host and one URL form per page", rules: span("IDX", 20, 23) },
  { label: "XML sitemaps", rules: span("IDX", 27, 32) },
  { label: "Parameter, filter and commerce utility pages controlled", rules: [...r("IDX", 24, 33, 34), "LNK-014"] },
  { label: "Page titles", rules: [...span("META", 1, 7), "META-020"] },
  { label: "Meta descriptions", rules: [...span("META", 8, 10), "META-021"] },
  { label: "html lang and charset", rules: r("META", 11, 12, 15) },
  { label: "Mobile viewport", rules: r("META", 13, 14) },
  { label: "Open Graph and Twitter cards", rules: r("META", 16, 17, 18, 22) },
  { label: "Favicon", rules: r("META", 19) },
  { label: "CMS version not exposed", rules: r("META", 23) },
  { label: "Heading structure", rules: [...span("CNT", 1, 4), ...r("CNT", 16, 17, 22)] },
  { label: "Content depth and duplication", rules: span("CNT", 5, 8) },
  { label: "Content quality signals", rules: r("CNT", 9, 10, 11, 12, 18) },
  { label: "Freshness, brand and contact consistency", rules: r("CNT", 19, 20, 21) },
  { label: "Internal links and orphan pages", rules: [...span("LNK", 1, 7), "LNK-011"] },
  { label: "Navigation, calls to action and link consistency", rules: r("LNK", 8, 9, 15, 16, 17) },
  { label: "External links", rules: r("LNK", 10) },
  { label: HREFLANG, rules: span("I18N", 1, 6) },
  { label: "Language handling and URL scripts", rules: r("I18N", 7, 8) },
  { label: "Images", rules: span("IMG", 1, 11) },
  { label: "Structured data", rules: span("SD", 1, 11) },
  { label: "Core Web Vitals and server response", rules: span("PERF", 1, 4) },
  { label: "Page weight and delivery", rules: span("PERF", 5, 11) },
  { label: "HTTPS and security headers", rules: span("SEC", 1, 6) },
  { label: "Accessibility", rules: span("A11Y", 1, 4) },
  { label: "AI crawler access", rules: span("AIS", 1, 5) },
];

export interface ChecklistRow {
  label: string;
  status: ChecklistStatus;
  /** Why, with the rule IDs behind the status. */
  detail: string;
}

export function checklistRows(groups: Pick<IssueGroupRow, "ruleId" | "priority" | "affectedUrls" | "inconclusiveUrls">[], runs: Pick<RuleRunRow, "ruleId" | "status" | "evaluated">[], languages: SiteLanguages | null = null): ChecklistRow[] {
  const byGroup = new Map(groups.map((g) => [g.ruleId, g]));
  const byRun = new Map(runs.map((x) => [x.ruleId, x]));
  return CHECKLIST.map(({ label, rules }) => {
    const found = rules.flatMap((id) => {
      const g = byGroup.get(id);
      return g && (g.affectedUrls > 0 || g.inconclusiveUrls > 0) ? [g] : [];
    });
    if (label === HREFLANG) {
      // Pass by absence would say a site with no hreflang has it right.
      if (!languages) return { label, status: "Not checked" as const, detail: "The site's languages were not recorded for this audit" };
      if (languages.hreflangPages === 0) {
        const names = languages.detected.map((l) => `${l.language} (${l.pages} pages)`).join(", ");
        if (languages.detected.length > 1) return { label, status: "Fail" as const, detail: `Several languages detected without hreflang: ${names}` };
        if (languages.detected.length === 1) return { label, status: "Not applicable" as const, detail: `One language detected: ${names}; no hreflang needed` };
        return { label, status: "Not checked" as const, detail: "No page's language was detected reliably, and no page has hreflang" };
      }
    }
    const failing = found.filter((g) => g.affectedUrls > 0 && ["critical", "high", "medium"].includes(g.priority));
    if (failing.length) return { label, status: "Fail" as const, detail: failing.map((g) => g.ruleId).join(", ") };
    if (found.length) return { label, status: "Warning" as const, detail: found.map((g) => g.ruleId).join(", ") };
    const notRun = rules.filter((id) => byRun.get(id)?.status !== "ran");
    if (notRun.length) return { label, status: "Not checked" as const, detail: `Did not run: ${notRun.join(", ")}` };
    // One such rule is enough: the Images row's size rules see only what the resource phase checked, whatever the alt-text rules read.
    const empty = rules.filter((id) => !byRun.get(id)?.evaluated);
    if (empty.length) return { label, status: "Not checked" as const, detail: `Nothing to evaluate: ${empty.join(", ")}` };
    return { label, status: "Pass" as const, detail: `${rules.length} ${rules.length === 1 ? "rule" : "rules"} ran, nothing found` };
  });
}
