import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { IssueDetailView } from "@/components/views/Issues";

export default function IssuePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <IssueDetailView />
    </Suspense>
  );
}
