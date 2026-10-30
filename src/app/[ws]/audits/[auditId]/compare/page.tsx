import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { AuditCompareView } from "@/components/views/Compare";

export default function ComparePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AuditCompareView />
    </Suspense>
  );
}
