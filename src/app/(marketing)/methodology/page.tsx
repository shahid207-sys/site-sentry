import type { Metadata } from "next";
import { Container, FinalCta, Section, SectionHeading, TrustSummary } from "@/components/marketing/sections";
import { CHECKS } from "@/lib/audit/catalog";
import { HEALTH_NOTE, HEALTH_WEIGHTS } from "@/lib/audit/health";
import { RULE_CATEGORIES } from "@/lib/audit/types";
import { LIMITS } from "@/lib/crawl/engine";
import { describeLimits, HERO_RATE_LIMIT, LEGACY_ENGINE_LIMITS, PROFILE_IDS, PROFILES } from "@/lib/crawl/profiles";
import { MAX_BYTES, MAX_REDIRECTS, TIMEOUT_MS } from "@/lib/fetch/safe-fetch";

export const metadata: Metadata = {
  title: "Methodology",
  description: "What SiteSentry checks, how it prioritises findings, when it calls an issue resolved, and what it cannot see.",
};

const CERTAINTY = [
  ["Verified", "Measured directly from the response: a missing tag, a 404, a noindex directive. If it's reported, it's there."],
  ["Heuristic", "Based on a threshold or convention, such as a title over 60 characters or fewer than 250 words. Useful, but a judgement call; thresholds are configurable."],
  ["Needs review", "Measured correctly but possibly intentional, such as an image with empty alt text. Only a person can decide."],
];

const PRIORITY = [
  ["Base severity", "High +3, medium +2, low +1. Workspace settings can override the severity of any check."],
  ["Important URLs", "+1 if the issue affects a URL you marked as important, +0.5 if it affects the homepage."],
  ["Scope", "+0.5 when it spans 2–4 URLs, +1 for 5 or more."],
  ["Certainty", "−1 for heuristic and needs-review findings, so a guess never outranks a verified defect of the same severity."],
  ["Kind", "−0.5 for improvement opportunities and observations, which aren't defects."],
];

export default function MethodologyPage() {
  const byCategory = RULE_CATEGORIES.map((c) => ({ ...c, checks: CHECKS.filter((k) => k.category === c.id) }));
  return (
    <>
      <section aria-labelledby="m-heading" className="hero-glow border-b border-line">
        <Container className="py-16 sm:py-24">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent-ink">Methodology</p>
          <h1 id="m-heading" className="mt-3 max-w-3xl text-4xl font-semibold tracking-[-0.03em] text-fg sm:text-5xl">
            Evidence first. Limits stated.
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-fg-2">
            SiteSentry reports what it can observe in the responses it fetches. When it can&apos;t observe something, it says so instead of guessing, and it never calls an issue fixed without re-checking it.
          </p>
        </Container>
      </section>

      <Section labelledBy="checks-heading">
        <Container>
          <SectionHeading id="checks-heading" eyebrow="Coverage" title={`${CHECKS.length} deterministic checks in ${RULE_CATEGORIES.length} categories`}>
            The same input always produces the same findings. You choose which categories an audit runs, and the audit records which pages and checks it actually covered.
          </SectionHeading>
          <div className="mt-10 grid gap-px overflow-hidden rounded-2xl border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
            {byCategory.map((c) => (
              <div key={c.id} className="bg-surface p-5">
                <p className="flex items-baseline justify-between gap-3">
                  <span className="font-semibold text-fg">{c.label}</span>
                  <span className="text-xs text-fg-3 tabular">{c.checks.length} checks</span>
                </p>
                <p className="mt-1 text-sm text-fg-2">{c.description}</p>
              </div>
            ))}
          </div>
        </Container>
      </Section>

      <Section labelledBy="certainty-heading" className="border-y border-line bg-surface">
        <Container>
          <SectionHeading id="certainty-heading" eyebrow="Confidence" title="Every finding says how sure it is" />
          <dl className="mt-10 grid gap-4 md:grid-cols-3">
            {CERTAINTY.map(([t, d]) => (
              <div key={t} className="rounded-2xl border border-line p-6">
                <dt className="text-lg font-semibold text-fg">{t}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-fg-2">{d}</dd>
              </div>
            ))}
          </dl>
        </Container>
      </Section>

      <Section labelledBy="priority-heading">
        <Container>
          <SectionHeading id="priority-heading" eyebrow="Priority" title="A score you can read, not a black box">
            Each finding shows the reasons behind its priority, P1 (most urgent) to P4. The score adds up as follows.
          </SectionHeading>
          <dl className="mt-10 divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
            {PRIORITY.map(([t, d]) => (
              <div key={t} className="grid gap-1 px-5 py-4 sm:grid-cols-[200px_1fr] sm:gap-6">
                <dt className="font-medium text-fg">{t}</dt>
                <dd className="text-sm text-fg-2">{d}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 text-sm text-fg-2">
            Example: images without width and height are a <span className="font-medium text-fg">low-severity layout-stability improvement</span> (they can cause layout shift), so they usually rank P4, not as a major SEO defect.
          </p>
        </Container>
      </Section>

      <Section labelledBy="health-heading">
        <Container>
          <SectionHeading id="health-heading" eyebrow="Health score" title="One number for triage, with the arithmetic shown">
            {HEALTH_NOTE}
          </SectionHeading>
          <div className="mt-10 grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
            <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
              <p className="font-mono text-sm text-fg">
                100 − {HEALTH_WEIGHTS.high} × high − {HEALTH_WEIGHTS.medium} × medium − {HEALTH_WEIGHTS.low} × low
              </p>
              <p className="mt-3 text-sm leading-relaxed text-fg-2">
                Counted per open issue type (one check failing on one site) at its worst severity, never below 0. 80 and above reads as good, 60–79 needs work, below 60 is poor.
              </p>
            </div>
            <div className="rounded-2xl border border-line bg-surface p-6 text-sm leading-relaxed text-fg-2 shadow-card">
              <p>
                Example: one high, five medium and seven low issue types give 100 − 10 − 15 − 7 = <span className="font-semibold text-fg">68</span>. Fixing the high-severity issue adds 10 points; fixing one image template that affects 25 pages adds 1, because it is one fix.
              </p>
              <p className="mt-3">The score says how much outstanding work an audit found. It is not a ranking factor, and it can&apos;t predict traffic.</p>
            </div>
          </div>
        </Container>
      </Section>

      <Section labelledBy="resolve-heading" className="border-y border-line bg-surface">
        <Container>
          <SectionHeading id="resolve-heading" eyebrow="History" title="When is an issue resolved?" />
          <div className="mt-8 grid gap-4 text-sm leading-relaxed text-fg-2 md:grid-cols-2">
            <p>
              Each issue has a stable fingerprint: the check, the normalised page URL and any expectation that shaped it. Wording and observed values are excluded, so an issue keeps its identity when its details change. Audit results are stored as snapshots that later audits never rewrite.
            </p>
            <p>
              An issue is <span className="font-medium text-fg">resolved</span> only when a later audit inspected the same page with the same check and didn&apos;t find it. If that audit skipped the page, timed out, or didn&apos;t run that check, the issue is <span className="font-medium text-fg">not re-checked</span>. A <span className="font-medium text-fg">regression</span> is an issue found where the previous audit ran the same check and found nothing; issues outside the previous audit&apos;s scope are reported as first detections instead.
            </p>
          </div>
        </Container>
      </Section>

      <Section labelledBy="limits-heading">
        <Container>
          <SectionHeading id="limits-heading" eyebrow="Limits" title="What it can and can't see" />
          <div className="mt-10">
            <TrustSummary />
          </div>
          <div className="mt-8 overflow-x-auto rounded-xl border border-line">
            <table className="w-full min-w-[520px] text-left text-sm">
              <caption className="sr-only">Crawl profiles</caption>
              <thead className="bg-surface-secondary text-[13px] text-fg-3">
                <tr>
                  <th scope="col" className="px-4 py-2.5 font-medium">Profile</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Limits</th>
                  <th scope="col" className="px-4 py-2.5 font-medium">Use</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle text-fg-2">
                {PROFILE_IDS.map((id) => {
                  const p = PROFILES[id];
                  return (
                    <tr key={id}>
                      <th scope="row" className="px-4 py-2.5 font-medium text-fg">{p.label}</th>
                      <td className="px-4 py-2.5">
                        {describeLimits(p.budget, p.maxDepth)}
                        {p.budgetEditable || p.depthEditable ? ` by default; ${[p.budgetEditable && "budget", p.depthEditable && "depth"].filter(Boolean).join(" and ")} set per audit` : ""}
                      </td>
                      <td className="px-4 py-2.5">{p.use}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <ul className="mt-8 grid list-disc gap-3 pl-5 text-sm text-fg-2 md:grid-cols-2">
            <li>The homepage form runs {PROFILES.quick.label} only, at most {HERO_RATE_LIMIT.audits} audits an hour from one address.</li>
            <li>Deployments still on the in-request engine stop at {describeLimits(LEGACY_ENGINE_LIMITS.maxPages, LEGACY_ENGINE_LIMITS.maxDepth)}, and the audit says so in its coverage notes. Up to {LIMITS.linkChecks} link targets are status-checked.</li>
            <li>{TIMEOUT_MS / 1000}s timeout per request, {MAX_BYTES / 1024 / 1024} MB of HTML per page, at most {MAX_REDIRECTS} redirects, each one re-validated.</li>
            <li>Only public http/https addresses. Private, loopback, link-local and cloud-metadata IPs are refused, including at connect time.</li>
            <li>robots.txt is respected. Character encoding comes from the Content-Type header only.</li>
            <li>No JavaScript rendering: content inserted client-side isn&apos;t seen.</li>
            <li>No search-performance data yet. Page HTML alone can&apos;t show that a change moved rankings; that would need Search Console data.</li>
          </ul>
        </Container>
      </Section>

      <FinalCta title="Try it on a page you know well." body="The fastest way to judge an audit tool is to point it at a site whose problems you already know." />
    </>
  );
}
