import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { BoardScreen } from "@/components/v2/screens/BoardScreen";

export default function AuditBoardPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <BoardScreen />
    </Suspense>
  );
}
