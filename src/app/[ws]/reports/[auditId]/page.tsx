import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { AuditReportView } from "@/components/views/Reports";

export default function AuditReportPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AuditReportView />
    </Suspense>
  );
}
