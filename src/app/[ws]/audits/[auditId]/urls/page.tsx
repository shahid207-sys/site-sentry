import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { UrlsScreen } from "@/components/v2/screens/UrlsScreen";

export default function AuditUrlsPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <UrlsScreen />
    </Suspense>
  );
}
