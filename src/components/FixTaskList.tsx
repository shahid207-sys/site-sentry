"use client";

import { useState } from "react";
import { fixTaskToMarkdown, type FixTask } from "@/lib/tasks/fix-task";
import { SeverityBadge } from "./SeverityBadge";

export function FixTaskList({
  tasks,
  onToggle,
  onRemove,
}: {
  tasks: FixTask[];
  onToggle: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  if (tasks.length === 0) return null;

  async function copy(task: FixTask) {
    try {
      await navigator.clipboard.writeText(fixTaskToMarkdown(task));
      setCopied(task.id);
      setTimeout(() => setCopied((c) => (c === task.id ? null : c)), 1500);
    } catch {
      setCopied(null);
    }
  }

  return (
    <section className="mt-8">
      <h2 className="text-sm font-semibold">
        Fix tasks <span className="font-normal text-muted">(this session only, not saved yet)</span>
      </h2>
      <ul className="mt-2 divide-y divide-line rounded-lg border border-line">
        {tasks.map((t) => (
          <li key={t.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <input
              type="checkbox"
              checked={t.status === "done"}
              onChange={() => onToggle(t.id)}
              aria-label={`Mark "${t.title}" done`}
            />
            <SeverityBadge severity={t.severity} />
            <div className="min-w-0 flex-1">
              <p className={t.status === "done" ? "text-muted line-through" : ""}>
                {t.title}
                {t.source === "sample" && <span className="ml-2 text-xs font-semibold text-amber-700 dark:text-amber-300">SAMPLE</span>}
              </p>
              <p className="truncate font-mono text-xs text-muted">{t.pageUrl}</p>
            </div>
            <button type="button" onClick={() => copy(t)} className="rounded border border-line px-2 py-1 text-xs">
              {copied === t.id ? "Copied" : "Copy as Markdown"}
            </button>
            <button type="button" onClick={() => onRemove(t.id)} className="rounded px-2 py-1 text-xs text-muted hover:text-foreground">
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
