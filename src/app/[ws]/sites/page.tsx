import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { SitesView } from "@/components/views/Sites";

export default function SitesPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={3} />}>
      <SitesView />
    </Suspense>
  );
}
