import type { Metadata } from "next";
import { ProductPreview } from "@/components/marketing/ProductPreview";
import { Container, FinalCta, Section, SectionHeading, VerificationFlow, WorkflowSteps } from "@/components/marketing/sections";

export const metadata: Metadata = {
  title: "How it works",
  description: "Scan, understand, take action and verify: how SiteSentry turns an audit into fixes that are re-checked against frozen acceptance criteria.",
};

const AUDIT_FACTS = [
  ["Bounded, resumable crawls", "Audits run in short steps that save their progress, so a closed tab or a server restart doesn't lose work. Open the audit again and it continues."],
  ["Coverage you can see", "Each audit lists what it couldn't do: page limits reached, pages that failed, sitemaps it didn't read. Results are never presented as more complete than they are."],
  ["Comparisons that respect scope", "Comparing two audits separates regressions, resolved issues, first detections and issues the newer audit didn't re-check."],
];

export default function HowItWorksPage() {
  return (
    <>
      <section aria-labelledby="h-heading" className="hero-glow border-b border-line">
        <Container className="py-16 sm:py-24">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent-ink">How it works</p>
          <h1 id="h-heading" className="mt-3 max-w-3xl text-4xl font-semibold tracking-[-0.03em] text-fg sm:text-5xl">
            A simple four-step workflow from audit to verified results
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-fg-2">
            Go from finding issues to fixing them and proving the improvements.
          </p>
        </Container>
      </section>
      <Section labelledBy="h-steps">
        <Container>
          <SectionHeading id="h-steps" eyebrow="Workflow" title="Scan, understand, take action, verify" />
          <div className="mt-10">
            <WorkflowSteps />
          </div>
          <dl className="mt-10 grid gap-4 md:grid-cols-3">
            {AUDIT_FACTS.map(([t, d]) => (
              <div key={t} className="rounded-2xl border border-line bg-surface p-6 shadow-card">
                <dt className="font-semibold text-fg">{t}</dt>
                <dd className="mt-2 text-sm leading-relaxed text-fg-2">{d}</dd>
              </div>
            ))}
          </dl>
        </Container>
      </Section>
      <Section labelledBy="h-example" className="border-y border-line bg-surface">
        <Container>
          <SectionHeading id="h-example" eyebrow="Worked example" title="One issue, start to finish" />
          <div className="mt-10">
            <ProductPreview />
          </div>
        </Container>
      </Section>
      <Section labelledBy="h-verify">
        <Container>
          <SectionHeading id="h-verify" eyebrow="Two statuses" title="People move the work. Re-checks decide if it's fixed." />
          <div className="mt-10">
            <VerificationFlow />
          </div>
        </Container>
      </Section>
      <FinalCta />
    </>
  );
}
