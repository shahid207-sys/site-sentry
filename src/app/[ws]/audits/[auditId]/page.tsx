import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { AuditDetailView } from "@/components/views/AuditDetail";

export default function AuditPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AuditDetailView />
    </Suspense>
  );
}
