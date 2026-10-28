import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { TaskDetailView } from "@/components/views/Tasks";

export default function TaskPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TaskDetailView />
    </Suspense>
  );
}
