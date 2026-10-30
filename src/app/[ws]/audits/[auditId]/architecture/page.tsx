import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { ArchitectureScreen } from "@/components/v2/screens/ArchitectureScreen";

export default function AuditArchitecturePage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <ArchitectureScreen />
    </Suspense>
  );
}
