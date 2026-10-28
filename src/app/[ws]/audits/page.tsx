import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { AuditsView } from "@/components/views/Audits";

export default function AuditsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AuditsView />
    </Suspense>
  );
}
