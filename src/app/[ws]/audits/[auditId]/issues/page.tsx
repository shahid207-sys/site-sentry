import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { IssuesScreen } from "@/components/v2/screens/IssuesScreen";

export default function AuditIssuesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <IssuesScreen />
    </Suspense>
  );
}
