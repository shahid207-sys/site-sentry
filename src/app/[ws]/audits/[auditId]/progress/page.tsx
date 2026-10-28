import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { AuditProgressView } from "@/components/views/AuditProgress";

export default function AuditProgressPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AuditProgressView />
    </Suspense>
  );
}
