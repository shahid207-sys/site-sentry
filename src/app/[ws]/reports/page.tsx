import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { ReportsView } from "@/components/views/Reports";

export default function ReportsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ReportsView />
    </Suspense>
  );
}
