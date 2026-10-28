import type { Metadata } from "next";
import { Container, FeatureGrid, FinalCta, Section, SectionHeading, UseCases } from "@/components/marketing/sections";

export const metadata: Metadata = {
  title: "Features · SiteSentry",
  description: "From technical audits to verified fixes, SiteSentry helps you find issues, coordinate improvements and maintain your website's technical health.",
};

export default function FeaturesPage() {
  return (
    <>
      <section aria-labelledby="f-heading" className="hero-glow border-b border-line">
        <Container className="py-16 sm:py-24">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent-ink">Features</p>
          <h1 id="f-heading" className="mt-3 max-w-3xl text-4xl font-semibold tracking-[-0.03em] text-fg sm:text-5xl">
            Everything you need for complete SEO operations
          </h1>
          <p className="mt-5 max-w-2xl text-lg leading-relaxed text-fg-2">
            From technical audits to verified fixes, SiteSentry helps you find issues, coordinate improvements and maintain your website&apos;s technical health.
          </p>
        </Container>
      </section>
      <Section labelledBy="f-grid">
        <Container>
          <SectionHeading id="f-grid" eyebrow="Features" title="Built for actionable results" />
          <div className="mt-10">
            <FeatureGrid />
          </div>
        </Container>
      </Section>
      <Section labelledBy="f-who" className="border-y border-line bg-surface">
        <Container>
          <SectionHeading id="f-who" eyebrow="Who it's for" title="Three roles, one shared record" />
          <div className="mt-10">
            <UseCases />
          </div>
        </Container>
      </Section>
      <FinalCta />
    </>
  );
}
