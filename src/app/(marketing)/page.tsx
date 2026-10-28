import type { Metadata } from "next";
import Link from "next/link";
import { CircleCheck } from "lucide-react";
import { HeroAuditForm } from "@/components/marketing/HeroAuditForm";
import { HeroProductPreview } from "@/components/marketing/HeroProductPreview";
import { ProductPreview } from "@/components/marketing/ProductPreview";
import { Container, FAQSection, FeatureGrid, FinalCta, Section, SectionHeading, TrustSummary, UseCases, VerificationFlow, WorkflowSteps } from "@/components/marketing/sections";

export const metadata: Metadata = {
  title: { absolute: "SiteSentry: From SEO findings to fixes you can verify" },
  description: "Audit your website, turn real evidence into developer-ready tasks, and check whether your fixes actually worked—all in one workspace.",
};

const PILLARS = ["No sign-up", "Respects robots.txt", "Evidence for every finding"];
// Plain text, not logos: SiteSentry reads served HTML, so it isn't tied to (or endorsed by) any platform.
const PLATFORMS = ["WordPress", "Shopify", "Webflow", "Wix", "Squarespace", "Next.js"];

export default function HomePage() {
  return (
    <>
      <section aria-labelledby="hero-heading" className="hero-glow relative overflow-hidden border-b border-line">
        <div className="dot-grid pointer-events-none absolute inset-y-0 right-0 hidden w-1/2 opacity-60 [mask-image:linear-gradient(to_left,black,transparent)] lg:block" aria-hidden />
        <Container className="relative py-14 sm:py-20 lg:py-24">
          <div className="grid grid-cols-1 items-center gap-12 lg:grid-cols-2 lg:gap-14 xl:gap-[70px]">
            <div>
              <p className="inline-flex items-center gap-2 rounded-full border border-accent/20 bg-surface px-3 py-1 text-xs font-semibold text-accent-ink shadow-card">
                <span className="size-1.5 rounded-full bg-accent" aria-hidden />
                Technical SEO, made verifiable
              </p>
              <h1 id="hero-heading" className="mt-5 text-[2.6rem] font-semibold leading-[1.05] tracking-[-0.035em] text-fg sm:text-[3.9rem] lg:text-[5rem]">
                From SEO findings to fixes you <span className="text-accent">can verify.</span>
              </h1>
              <p className="mt-5 max-w-2xl text-xl leading-relaxed text-fg">
                Audit your website, turn real evidence into developer-ready tasks, and check whether each fix actually worked, all in one workspace.
              </p>
              <div id="audit" className="mt-8 max-w-xl scroll-mt-24">
                <HeroAuditForm />
              </div>
              <ul className="mt-7 flex flex-wrap gap-x-6 gap-y-2.5 text-sm text-fg">
                {PILLARS.map((p) => (
                  <li key={p} className="flex items-center gap-2">
                    <CircleCheck className="size-4 text-ok" aria-hidden />
                    {p}
                  </li>
                ))}
              </ul>
            </div>
            <HeroProductPreview />
          </div>
        </Container>
      </section>

      <section aria-label="Works with any platform" className="border-b border-line bg-surface">
        <Container className="flex flex-col items-center gap-4 py-8 sm:flex-row sm:justify-between">
          <p className="text-sm font-medium text-fg-2">Reads the HTML any platform serves</p>
          <ul className="flex flex-wrap justify-center gap-x-8 gap-y-2 text-[15px] font-semibold tracking-tight text-fg-3">
            {PLATFORMS.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        </Container>
      </section>

      <Section labelledBy="features-heading" id="features">
        <Container>
          <SectionHeading
            id="features-heading"
            center
            eyebrow="Features"
            title="Everything you need for complete SEO operations"
          >
            From technical audits to verified fixes, SiteSentry helps you find issues, coordinate improvements and maintain your website&apos;s technical health.
          </SectionHeading>
          <div className="mt-12">
            <FeatureGrid />
          </div>
        </Container>
      </Section>

      <Section labelledBy="how-heading" id="how-it-works" className="border-y border-line bg-surface">
        <Container>
          <SectionHeading
            id="how-heading"
            center
            eyebrow="How it works"
            title="A simple four-step workflow from audit to verified results"
          >
            Go from finding issues to fixing them and proving the improvements.
          </SectionHeading>
          <div className="mt-14">
            <WorkflowSteps />
          </div>
        </Container>
      </Section>

      <Section labelledBy="preview-heading" id="product">
        <Container>
          <SectionHeading id="preview-heading" eyebrow="In-Depth Inspection" title="Find it, fix it, prove it.">
            One issue from the sample workspace, as SiteSentry shows it: what was observed, what the developer must change, and the re-check that confirms it.
          </SectionHeading>
          <div className="mt-10">
            <ProductPreview />
          </div>
        </Container>
      </Section>

      <Section labelledBy="verify-heading" className="border-y border-line bg-surface">
        <Container>
          <SectionHeading id="verify-heading" eyebrow="Verification" title="Marking a task done isn't the same as fixing it.">
            SiteSentry keeps two separate statuses, so a closed ticket never passes for a fixed page.
          </SectionHeading>
          <div className="mt-10">
            <VerificationFlow />
          </div>
        </Container>
      </Section>

      <Section labelledBy="who-heading">
        <Container>
          <SectionHeading id="who-heading" eyebrow="Who it's for" title="For the people who find, fix and report." />
          <div className="mt-10">
            <UseCases />
          </div>
        </Container>
      </Section>

      <Section labelledBy="trust-heading" className="border-y border-line bg-surface">
        <Container>
          <SectionHeading id="trust-heading" eyebrow="Methodology" title="It reports what it can observe, and says when it can't.">
            Every audit lists the pages it inspected, the ones it couldn&apos;t reach, and the limits it hit.
          </SectionHeading>
          <div className="mt-10">
            <TrustSummary />
          </div>
          <p className="mt-6 text-sm text-fg-2">
            <Link href="/methodology" className="font-medium text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg">
              Read the full methodology and limitations
            </Link>
          </p>
        </Container>
      </Section>

      <Section labelledBy="faq-heading">
        <Container className="max-w-3xl">
          <SectionHeading id="faq-heading" eyebrow="FAQ" title="Questions, answered plainly." />
          <div className="mt-8">
            <FAQSection />
          </div>
        </Container>
      </Section>

      <FinalCta />
    </>
  );
}
