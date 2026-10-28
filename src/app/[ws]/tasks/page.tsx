import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { TasksView } from "@/components/views/Tasks";

export default function TasksPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <TasksView />
    </Suspense>
  );
}
