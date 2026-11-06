import type { Metadata } from "next";
import { PublicSampleAudit } from "@/components/views/PublicSampleAudit";
import { getSampleShowcase } from "@/lib/sample/showcase";

export const metadata: Metadata = {
  title: "Sample audit",
  description: "A full technical SEO audit of a fictional store, produced by the SiteSentry engine: health score, grouped issues with evidence, affected pages and how to fix each one.",
};

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

export default function SampleAuditPage() {
  const data = getSampleShowcase();
  return <PublicSampleAudit data={data} auditedLabel={DATE.format(new Date(data.auditedAt))} />;
}
