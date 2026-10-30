import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { ContentScreen } from "@/components/v2/screens/ContentScreen";

export default function AuditContentPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ContentScreen />
    </Suspense>
  );
}
