import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { NewAuditView } from "@/components/views/Audits";

export default function NewAuditPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={4} />}>
      <NewAuditView />
    </Suspense>
  );
}
