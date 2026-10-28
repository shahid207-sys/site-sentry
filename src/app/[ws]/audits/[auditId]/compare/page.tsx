import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { CompareView } from "@/components/views/Compare";

export default function ComparePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <CompareView />
    </Suspense>
  );
}
