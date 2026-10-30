"use client";
// Shared hooks of the v2 screens: filters as URL state (SPEC "Global patterns": every filter, sort and grouping is
// in the query string), keyboard shortcuts, and the rule catalog.
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RULE_TITLES } from "@/lib/rules/titles";
import type { CatalogRule } from "@/lib/server/results";
import { api } from "../lib/api";

/**
 * Read and write query-string state. `set` merges keys (null or "" removes one) and replaces the history entry, so
 * typing in a filter does not flood the back button; pass push: true for navigational changes (tabs, grouping).
 * Components calling this must sit inside a <Suspense> boundary (useSearchParams under cacheComponents).
 */
export function useQueryState() {
  const sp = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const get = useCallback((k: string) => sp.get(k), [sp]);
  const set = useCallback(
    (patch: Record<string, string | null | undefined>, opts: { push?: boolean } = {}) => {
      // Read the live URL, not the render's params: a debounced write (useQueryText) must not undo a filter changed
      // since it was scheduled.
      const p = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(patch)) {
        if (v === null || v === undefined || v === "") p.delete(k);
        else p.set(k, v);
      }
      const url = `${pathname}${p.size ? `?${p}` : ""}`;
      if (opts.push) router.push(url, { scroll: false });
      else router.replace(url, { scroll: false });
    },
    [router, pathname],
  );
  return { get, set, params: sp };
}

/** A text filter bound to the query string, debounced so typing stays responsive on big tables. */
export function useQueryText(key: string, delayMs = 120): [string, (v: string) => void] {
  const { get, set } = useQueryState();
  const external = get(key) ?? "";
  const [value, setValue] = useState(external);
  const [synced, setSynced] = useState(external);
  // Back/forward or a link changed the URL: follow it (state adjusted during render, not in an effect).
  if (external !== synced) {
    setSynced(external);
    setValue(external);
  }
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const update = useCallback(
    (v: string) => {
      setValue(v);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        setSynced(v);
        set({ [key]: v });
      }, delayMs);
    },
    [key, set, delayMs],
  );
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  return [value, update];
}

const typing = (t: EventTarget | null) => t instanceof HTMLElement && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));

/**
 * Single-key shortcuts (j, k, x, f, e, Enter, /, ?) while focus is not in a text field or an open dialog. Keys with
 * Ctrl/Meta/Alt are left to the browser and the command palette.
 */
export function useHotkeys(map: Record<string, (e: KeyboardEvent) => void>, enabled = true) {
  const ref = useRef(map);
  useEffect(() => {
    ref.current = map;
  });
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || e.defaultPrevented) return;
      if (typing(e.target)) return;
      // Enter on a focused link or button activates it, not the row.
      if (e.key === "Enter" && e.target instanceof HTMLElement && e.target.closest("a,button,summary,[role=button]")) return;
      if (document.querySelector("dialog[open]")) return;
      const fn = ref.current[e.key];
      if (!fn) return;
      e.preventDefault();
      fn(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}

let catalog: Promise<CatalogRule[]> | null = null;

/** The rule catalog (titles, why / fix / acceptance), fetched once per page load. */
export function useRules(apiBase: string): Map<string, CatalogRule> | null {
  const [rules, setRules] = useState<CatalogRule[] | null>(null);
  useEffect(() => {
    let live = true;
    catalog ??= api<CatalogRule[]>(`${apiBase}/rules`).catch((e) => {
      catalog = null;
      throw e;
    });
    catalog.then((r) => live && setRules(r)).catch(() => undefined);
    return () => {
      live = false;
    };
  }, [apiBase]);
  return useMemo(() => (rules ? new Map(rules.map((r) => [r.id, r])) : null), [rules]);
}

/** A rule's display title (plain data, available before the catalog loads). */
export const ruleTitle = (id: string) => RULE_TITLES[id] ?? id;
