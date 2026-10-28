import { Suspense } from "react";
import { PageSkeleton } from "@/components/ui";
import { SettingsView } from "@/components/views/Settings";

export default function SettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton rows={8} />}>
      <SettingsView />
    </Suspense>
  );
}
