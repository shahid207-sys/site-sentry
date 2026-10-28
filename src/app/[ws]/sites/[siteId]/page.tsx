import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { SiteDetailView } from "@/components/views/Sites";

export default function SitePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <SiteDetailView />
    </Suspense>
  );
}
