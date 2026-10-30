"use client";
// The "?" shortcut sheet (SPEC "Global patterns"). Opens from anywhere in the app when focus is not in a text field.
import { useState } from "react";
import { Modal } from "../overlays";
import { useHotkeys } from "../v2/hooks";

const SHORTCUTS: { keys: string[]; what: string }[] = [
  { keys: ["Ctrl", "K"], what: "Search and jump: sites, audits, issue rules, URLs, actions" },
  { keys: ["j"], what: "Next row" },
  { keys: ["k"], what: "Previous row" },
  { keys: ["Enter"], what: "Open the row (drawer or page)" },
  { keys: ["x"], what: "Select the row" },
  { keys: ["e"], what: "Expand evidence (Issues)" },
  { keys: ["f"], what: "Mark the row fixed (Issues)" },
  { keys: ["/"], what: "Focus the filter" },
  { keys: ["?"], what: "Show this sheet" },
  { keys: ["Esc"], what: "Close a drawer or dialog" },
];

export function ShortcutSheet() {
  const [open, setOpen] = useState(false);
  useHotkeys({
    "?": () => setOpen(true),
    "/": () => {
      const f = document.querySelector<HTMLInputElement>("[data-filter-input]");
      if (f) f.focus();
    },
  });
  return (
    <Modal open={open} onClose={() => setOpen(false)} title="Keyboard shortcuts" description="Single keys work when focus is not in a text field.">
      <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2.5 text-sm">
        {SHORTCUTS.map((s) => (
          <div key={s.what} className="contents">
            <dt className="flex gap-1">
              {s.keys.map((k) => (
                <kbd key={k} className="rounded-md border border-line bg-surface-secondary px-1.5 py-0.5 font-mono text-[12px] text-fg">
                  {k}
                </kbd>
              ))}
            </dt>
            <dd className="text-fg-2">{s.what}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
