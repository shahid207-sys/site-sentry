import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { InspectScreen } from "@/components/v2/screens/InspectScreen";

export default function AuditInspectPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <InspectScreen />
    </Suspense>
  );
}
