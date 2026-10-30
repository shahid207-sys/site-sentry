"use client";
import { Monitor, Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

type Theme = "system" | "light" | "dark";
const KEY = "ss-theme";
const listeners = new Set<() => void>();

const read = (): Theme => {
  const t = document.documentElement.dataset.theme;
  return t === "light" || t === "dark" ? t : "system";
};

function apply(t: Theme) {
  if (t === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, t);
  } catch {
    // Storage blocked: the choice lasts until reload.
  }
  listeners.forEach((l) => l());
}

const NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const ICON = { system: Monitor, light: Sun, dark: Moon };
const LABEL: Record<Theme, string> = { system: "System theme", light: "Light theme", dark: "Dark theme" };

/** Cycles system → light → dark. The choice is applied before first paint by the script in src/app/layout.tsx. */
export function ThemeToggle() {
  const theme = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    read,
    () => "system" as Theme,
  );
  const Icon = ICON[theme];
  return (
    <button
      type="button"
      onClick={() => apply(NEXT[theme])}
      className="flex size-10 shrink-0 items-center justify-center rounded-[10px] border border-line bg-surface text-fg-2 hover:border-line-strong hover:text-fg"
      aria-label={`${LABEL[theme]}. Switch to ${LABEL[NEXT[theme]].toLowerCase()}`}
      title={`${LABEL[theme]} (click for ${LABEL[NEXT[theme]].toLowerCase()})`}
    >
      <Icon className="size-4" aria-hidden />
    </button>
  );
}
