import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { HandoffReportView } from "@/components/views/Reports";

export default function HandoffPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <HandoffReportView />
    </Suspense>
  );
}
