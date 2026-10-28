import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { IssuesView } from "@/components/views/Issues";

export default function IssuesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <IssuesView />
    </Suspense>
  );
}
