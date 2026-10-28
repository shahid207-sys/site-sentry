"use client";
import { RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { Button, EmptyState } from "@/components/ui";

/** Catches render errors in any workspace page; the shell stays usable. */
export default function WorkspaceError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[site-sentry] page error", error.digest ?? "");
  }, [error]);
  return (
    <div className="rounded-[10px] border border-sev-high/25 bg-surface">
      <EmptyState icon={RefreshCw} title="This page failed to render" action={<Button onClick={reset}>Try again</Button>}>
        Something unexpected went wrong while showing this view. Your data was not changed.
      </EmptyState>
    </div>
  );
}
