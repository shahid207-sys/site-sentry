"use client";
// The data table of the v2 screens: virtualised (only visible rows are in the DOM, so 50k rows filter and scroll
// fast), with ARIA table semantics, sortable headers, a density toggle, row selection and j / k / x / Enter.
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ArrowUpDown, Rows2, Rows4 } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { cx } from "../ui";
import { useHotkeys } from "./hooks";

export interface Column<T> {
  id: string;
  header: string;
  /** CSS grid track, e.g. "minmax(280px, 1fr)" or "96px". */
  width: string;
  cell: (row: T) => ReactNode;
  /** Sortable when given; the parent sorts (see sortRows). */
  sortable?: boolean;
  align?: "right";
}

export type Density = "comfortable" | "compact";
const ROW_HEIGHT: Record<Density, number> = { comfortable: 44, compact: 32 };
const HEADER_H = 34;
const DENSITY_KEY = "ss-density";
const densityListeners = new Set<() => void>();

function readDensity(): Density {
  try {
    return localStorage.getItem(DENSITY_KEY) === "compact" ? "compact" : "comfortable";
  } catch {
    return "comfortable";
  }
}

/** The viewer's table density, shared by every table and remembered in this browser. */
export function useDensity(): [Density, (d: Density) => void] {
  const density = useSyncExternalStore(
    (cb) => {
      densityListeners.add(cb);
      return () => densityListeners.delete(cb);
    },
    readDensity,
    () => "comfortable" as Density,
  );
  const set = useCallback((d: Density) => {
    try {
      localStorage.setItem(DENSITY_KEY, d);
    } catch {
      // Storage blocked: the choice lasts until reload.
    }
    densityListeners.forEach((l) => l());
  }, []);
  return [density, set];
}

export function DensityToggle() {
  const [density, setDensity] = useDensity();
  const next = density === "comfortable" ? "compact" : "comfortable";
  const Icon = density === "comfortable" ? Rows4 : Rows2;
  return (
    <button
      type="button"
      onClick={() => setDensity(next)}
      className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg-2 hover:border-line-strong hover:text-fg"
      aria-label={`Row density: ${density}. Switch to ${next}`}
      title={`Switch to ${next} rows`}
    >
      <Icon className="size-4" aria-hidden />
      <span className="hidden sm:inline">{density === "comfortable" ? "Comfortable" : "Compact"}</span>
    </button>
  );
}

export type SortState = { id: string; dir: "asc" | "desc" } | null;

/** Parse "column" / "-column" from the query string. */
export const parseSort = (v: string | null): SortState => (v ? (v.startsWith("-") ? { id: v.slice(1), dir: "desc" } : { id: v, dir: "asc" }) : null);
export const formatSort = (s: SortState) => (s ? `${s.dir === "desc" ? "-" : ""}${s.id}` : null);

/** A stable sort by one key (nulls last either way). */
export function sortRows<T>(rows: T[], sort: SortState, key: (row: T, id: string) => string | number | null): T[] {
  if (!sort) return rows;
  const dir = sort.dir === "asc" ? 1 : -1;
  const keyed = rows.map((r, i) => ({ r, i, k: key(r, sort.id) }));
  keyed.sort((a, b) => {
    if (a.k === b.k) return a.i - b.i;
    if (a.k === null) return 1;
    if (b.k === null) return -1;
    return (a.k < b.k ? -1 : 1) * dir;
  });
  return keyed.map((x) => x.r);
}

export function VirtualTable<T>({
  rows,
  columns,
  rowKey,
  label,
  onOpen,
  selected,
  onToggleSelect,
  sort,
  onSort,
  height = "calc(100dvh - 300px)",
  empty,
  keyboard = true,
  activeKey,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  /** Accessible name of the table. */
  label: string;
  /** Enter, or a click on the row. */
  onOpen?: (row: T) => void;
  selected?: Set<string>;
  onToggleSelect?: (key: string) => void;
  sort?: SortState;
  onSort?: (id: string) => void;
  /** Height of the scrolling body (min 240px). */
  height?: string;
  empty?: ReactNode;
  /** Bind j / k / x / Enter (one table per screen). */
  keyboard?: boolean;
  /** Row to highlight as open (e.g. the drawer's subject). */
  activeKey?: string | null;
}) {
  const [density] = useDensity();
  const scroller = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);
  // The header is sticky inside the scroller: rows start HEADER_H below its top. TanStack Virtual returns fresh
  // functions every render, so the React Compiler leaves this component unmemoised (expected).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT[density],
    overscan: 12,
    scrollMargin: HEADER_H,
    scrollPaddingStart: HEADER_H,
  });
  useEffect(() => virtualizer.measure(), [density, virtualizer]);
  const at = Math.min(cursor, Math.max(rows.length - 1, 0));

  const move = (d: number) => {
    if (!rows.length) return;
    const i = Math.max(0, Math.min(rows.length - 1, at + d));
    setCursor(i);
    virtualizer.scrollToIndex(i, { align: "auto" });
  };
  useHotkeys(
    {
      j: () => move(1),
      ArrowDown: () => move(1),
      k: () => move(-1),
      ArrowUp: () => move(-1),
      Enter: () => rows[at] && onOpen?.(rows[at]),
      x: () => rows[at] && onToggleSelect?.(rowKey(rows[at])),
    },
    keyboard,
  );

  const template = [onToggleSelect ? "36px" : null, ...columns.map((c) => c.width)].filter(Boolean).join(" ");
  const rowH = ROW_HEIGHT[density];
  const items = virtualizer.getVirtualItems();
  // Fewer rows than the body height: shrink to fit instead of leaving blank space.
  const full = rows.length * rowH + HEADER_H + 2;

  return (
    <div role="table" aria-label={label} aria-rowcount={rows.length + 1} className="overflow-hidden rounded-xl border border-line bg-surface">
      <div ref={scroller} className="overflow-auto" style={{ height: rows.length ? height : undefined, minHeight: Math.min(240, full), maxHeight: full }}>
        <div role="rowgroup" className="sticky top-0 z-10 min-w-fit">
          <div role="row" aria-rowindex={1} className="grid border-b border-line bg-surface-secondary text-xs font-medium text-fg-2" style={{ gridTemplateColumns: template, height: HEADER_H }}>
            {onToggleSelect ? <span role="columnheader" className="flex items-center px-2"><span className="sr-only">Selected</span></span> : null}
            {columns.map((c) => {
              const active = sort?.id === c.id;
              const ariaSort = active ? (sort!.dir === "asc" ? "ascending" : "descending") : c.sortable ? "none" : undefined;
              const Icon = active ? (sort!.dir === "asc" ? ArrowUp : ArrowDown) : ArrowUpDown;
              return (
                <span key={c.id} role="columnheader" aria-sort={ariaSort} className={cx("flex min-w-0 items-center px-3", c.align === "right" && "justify-end")}>
                  {c.sortable && onSort ? (
                    <button type="button" onClick={() => onSort(c.id)} className={cx("inline-flex items-center gap-1 truncate rounded hover:text-fg", active && "text-fg")}>
                      {c.header}
                      <Icon className={cx("size-3.5 shrink-0", !active && "opacity-40")} aria-hidden />
                    </button>
                  ) : (
                    <span className="truncate">{c.header}</span>
                  )}
                </span>
              );
            })}
          </div>
        </div>
        {rows.length === 0 ? (
          <div className="px-4 py-10">{empty}</div>
        ) : (
          <div role="rowgroup" className="relative min-w-fit" style={{ height: virtualizer.getTotalSize() }}>
            {items.map((v) => {
              const row = rows[v.index];
              const key = rowKey(row);
              const isCursor = v.index === at;
              const isSelected = selected?.has(key) ?? false;
              return (
                <div
                  key={key}
                  role="row"
                  aria-rowindex={v.index + 2}
                  aria-selected={onToggleSelect ? isSelected : undefined}
                  data-cursor={isCursor || undefined}
                  onClick={(e) => {
                    setCursor(v.index);
                    if (onOpen && !(e.target as HTMLElement).closest("a,button,input,label")) onOpen(row);
                  }}
                  className={cx(
                    "absolute left-0 top-0 grid w-full min-w-fit items-center border-b border-line-subtle text-[13px]",
                    onOpen && "cursor-pointer",
                    activeKey === key ? "bg-accent-softer" : isSelected ? "bg-info-soft" : "hover:bg-hover",
                    isCursor && "shadow-[inset_3px_0_0_var(--accent)]",
                  )}
                  style={{ gridTemplateColumns: template, height: rowH, transform: `translateY(${v.start - HEADER_H}px)` }}
                >
                  {onToggleSelect ? (
                    <span role="cell" className="flex justify-center px-2">
                      <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={isSelected} onChange={() => onToggleSelect(key)} aria-label="Select row" />
                    </span>
                  ) : null}
                  {columns.map((c) => (
                    <span key={c.id} role="cell" className={cx("min-w-0 truncate px-3", c.align === "right" && "text-right tabular")}>
                      {c.cell(row)}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
