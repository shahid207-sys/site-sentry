"use client";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Globe, Plus, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cx } from "../ui";
import { NAV } from "./nav";
import { useWs } from "./context";

interface Item {
  id: string;
  label: string;
  hint: string;
  href: string;
  icon: typeof Globe;
}

/** Jump to any section, site or the audit setup. Keyboard: ↑ ↓ Enter, Esc to close. */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { base, sites, ws } = useWs();
  const router = useRouter();
  const ref = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      setQ("");
      setSel(0);
      setTimeout(() => input.current?.focus(), 0);
    }
    if (!open && d.open) d.close();
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const all: Item[] = [
      ...NAV.map((n) => ({ id: `nav-${n.label}`, label: n.label, hint: "Go to", href: `${base}${n.href}`, icon: n.icon })),
      { id: "new-audit", label: "New audit", hint: "Action", href: `${base}/audits/new`, icon: Plus },
      ...(ws === "live" ? [{ id: "add-site", label: "Add a site", hint: "Action", href: `${base}/sites?add=1`, icon: Plus }] : []),
      ...(sites.data ?? []).flatMap((s) => [
        { id: `site-${s.site.id}`, label: s.site.name, hint: s.site.origin.replace(/^https?:\/\//, ""), href: `${base}/sites/${s.site.id}`, icon: Globe },
        { id: `issues-${s.site.id}`, label: `${s.site.name}: open issues`, hint: `${s.openTotal} open`, href: `${base}/issues?site=${s.site.id}`, icon: NAV[3].icon },
      ]),
    ];
    const t = q.trim().toLowerCase();
    return t ? all.filter((i) => `${i.label} ${i.hint}`.toLowerCase().includes(t)) : all.slice(0, 12);
  }, [base, sites.data, q, ws]);

  const go = (i: Item | undefined) => {
    if (!i) return;
    onClose();
    router.push(i.href);
  };

  return (
    <dialog
      ref={ref}
      aria-label="Search and jump to"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => e.target === ref.current && onClose()}
      className="mx-auto mt-[12vh] w-[calc(100vw-2rem)] max-w-lg rounded-xl border-0 bg-elevated p-0 text-fg shadow-pop backdrop:bg-scrim"
    >
      {open ? (
        <div>
          <div className="flex items-center gap-2 border-b border-line px-4">
            <Search className="size-4 shrink-0 text-fg-3" aria-hidden />
            <input
              ref={input}
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setSel(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "ArrowDown") {
                  e.preventDefault();
                  setSel((s) => Math.min(items.length - 1, s + 1));
                } else if (e.key === "ArrowUp") {
                  e.preventDefault();
                  setSel((s) => Math.max(0, s - 1));
                } else if (e.key === "Enter") {
                  e.preventDefault();
                  go(items[sel]);
                }
              }}
              placeholder="Jump to a section or site…"
              aria-label="Search"
              aria-controls="palette-list"
              aria-activedescendant={items[sel] ? `pal-${items[sel].id}` : undefined}
              className="h-12 flex-1 bg-transparent text-sm text-fg placeholder:text-fg-3 focus:outline-none"
            />
            <kbd className="rounded border border-line px-1.5 text-[11px] text-fg-3">Esc</kbd>
          </div>
          <ul id="palette-list" role="listbox" className="max-h-[50vh] overflow-y-auto p-1.5">
            {items.length === 0 ? <li className="px-3 py-6 text-center text-sm text-fg-3">No matches for “{q}”.</li> : null}
            {items.map((i, idx) => {
              const Icon = i.icon;
              return (
                <li
                  key={i.id}
                  id={`pal-${i.id}`}
                  role="option"
                  aria-selected={idx === sel}
                  onMouseEnter={() => setSel(idx)}
                  onClick={() => go(i)}
                  className={cx("flex cursor-pointer items-center gap-3 rounded-md px-3 py-2 text-sm", idx === sel ? "bg-hover text-fg" : "text-fg-2")}
                >
                  <Icon className="size-4 shrink-0 text-fg-3" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{i.label}</span>
                  <span className="truncate text-xs text-fg-3">{i.hint}</span>
                  {idx === sel ? <CornerDownLeft className="size-3.5 text-fg-3" aria-hidden /> : null}
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </dialog>
  );
}
