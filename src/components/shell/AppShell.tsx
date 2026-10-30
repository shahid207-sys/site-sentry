"use client";
import Link from "next/link";
import { notFound, usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, ChevronsUpDown, FlaskConical, Globe, House, Menu, Plus, Search, X } from "lucide-react";
import { Suspense, use, useEffect, useState, type ReactNode } from "react";
import type { Workspace } from "@/lib/model";
import { Logo } from "../Logo";
import { ToastProvider } from "../overlays";
import { LinkButton, PageSkeleton, cx } from "../ui";
import { CommandPalette } from "./CommandPalette";
import { ShortcutSheet } from "./ShortcutSheet";
import { ThemeToggle } from "./ThemeToggle";
import { useWs, WorkspaceProvider } from "./context";
import { NAV } from "./nav";

function SidebarNav({ ws, onNavigate }: { ws: Workspace; onNavigate?: () => void }) {
  const pathname = usePathname();
  const rest = pathname.slice(`/${ws}`.length);
  return (
    <nav aria-label="Primary">
      <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3">Workspace</p>
      <ul className="flex flex-col gap-1">
        <li>
          <Link href="/" prefetch={false} onClick={onNavigate} className="group flex h-10 items-center gap-3 rounded-[10px] px-3 text-sm font-medium text-fg-2 transition-colors hover:bg-hover hover:text-fg">
            <House className="size-[18px] shrink-0 text-fg-3 group-hover:text-fg-2" aria-hidden />
            <span className="truncate">Home</span>
          </Link>
        </li>
        {NAV.map((n) => {
          const active = n.match(rest);
          const Icon = n.icon;
          return (
            <li key={n.label}>
              <Link
                href={`/${ws}${n.href}`}
                // No viewport prefetch: every screen would request every section's shell on load, and those requests
                // queue on the server ahead of the screen's own data. A click loads the section.
                prefetch={false}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={cx(
                  "group flex h-10 items-center gap-3 rounded-[10px] px-3 text-sm transition-colors",
                  active ? "bg-sidebar-active font-semibold text-accent-ink" : "font-medium text-fg-2 hover:bg-hover hover:text-fg",
                )}
              >
                <Icon className={cx("size-[18px] shrink-0", active ? "text-accent-ink" : "text-fg-3 group-hover:text-fg-2")} aria-hidden />
                <span className="truncate">{n.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function WorkspaceSwitch({ ws }: { ws: Workspace }) {
  const pathname = usePathname();
  // Keep the section (e.g. /issues) when switching workspace; drop ids that belong to the other workspace.
  const section = pathname.slice(`/${ws}`.length).split("/")[1] ?? "";
  const target = (w: Workspace) => `/${w}${section ? `/${section}` : ""}`;
  return (
    <div>
      <p className="mb-1.5 px-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-fg-3">Data</p>
      <div role="radiogroup" aria-label="Workspace" className="grid grid-cols-2 gap-1 rounded-[10px] border border-line bg-elevated p-1">
        {(["live", "sample"] as const).map((w) => (
          <Link
            key={w}
            role="radio"
            aria-checked={ws === w}
            href={target(w)}
            prefetch={false}
            className={cx("flex h-8 items-center justify-center gap-1.5 rounded-lg text-[13px] font-medium transition-colors", ws === w ? (w === "sample" ? "bg-surface text-sample shadow-card" : "bg-surface text-fg shadow-card") : "text-fg-2 hover:text-fg")}
          >
            {w === "sample" ? <FlaskConical className="size-3.5" aria-hidden /> : null}
            {w === "live" ? "My sites" : "Sample"}
          </Link>
        ))}
      </div>
      <Link href="/" prefetch={false} className="mt-3 flex items-center gap-1.5 px-1 text-[13px] text-fg-3 hover:text-fg">
        SiteSentry home
        <ArrowUpRight className="size-3.5" aria-hidden />
      </Link>
    </div>
  );
}

/** Site context switcher. On a site page it swaps the site; on list pages it filters by ?site=. */
function SiteSwitcher() {
  const { base, sites } = useWs();
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const rest = pathname.slice(base.length);
  const onSite = rest.match(/^\/sites\/([^/]+)/);
  const current = onSite?.[1] ?? sp.get("site") ?? "";
  const list = sites.data ?? [];
  if (list.length === 0) return null;

  const change = (id: string) => {
    if (onSite) return router.push(id ? `${base}/sites/${id}` : `${base}/sites`);
    const filterable = /^\/(issues|audits|tasks|reports)\/?$/.test(rest) || rest.startsWith("/audits/new");
    if (filterable) {
      const p = new URLSearchParams(sp.toString());
      if (id) p.set("site", id);
      else p.delete("site");
      const qs = p.toString();
      return router.push(`${pathname}${qs ? `?${qs}` : ""}`);
    }
    router.push(id ? `${base}/sites/${id}` : `${base}/sites`);
  };

  return (
    <label className="relative block min-w-0">
      <span className="sr-only">Site</span>
      <Globe className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-3" aria-hidden />
      <select
        value={list.some((s) => s.site.id === current) ? current : ""}
        onChange={(e) => change(e.target.value)}
        className="h-10 w-full cursor-pointer appearance-none truncate rounded-[10px] border border-line bg-surface pl-9 pr-8 text-sm font-medium text-fg shadow-[0_1px_2px_rgb(16_24_40/0.04)] hover:border-line-strong focus:border-accent-ink focus:outline-none focus:ring-2 focus:ring-accent/20"
      >
        <option value="">All sites</option>
        {list.map((s) => (
          <option key={s.site.id} value={s.site.id}>
            {s.site.name}
          </option>
        ))}
      </select>
      <ChevronsUpDown className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-3" aria-hidden />
    </label>
  );
}

function Shell({ ws, children }: { ws: Workspace; children: ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const [palette, setPalette] = useState(false);
  const pathname = usePathname();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- close the mobile drawer on navigation
    setMobileOpen(false);
  }, [pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if (e.key === "Escape") setMobileOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The generic entry point never carries a site; only explicit "Audit this site" links do.
  const newAuditHref = `/${ws}/audits/new`;

  return (
    <div className="flex min-h-dvh">
      <a href="#main" className="sr-only z-50 rounded bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </a>

      {/* Desktop sidebar: labels always visible. */}
      <aside className="no-print sticky top-0 hidden h-dvh w-[252px] shrink-0 flex-col border-r border-line bg-surface md:flex">
        <div className="flex h-16 items-center px-5">
          <Link href="/" prefetch={false} aria-label="SiteSentry home">
            <Logo />
          </Link>
        </div>
        <div className="px-4 pb-1">
          <SiteSwitcher />
        </div>
        <div className="flex-1 overflow-y-auto px-3 py-4">
          <SidebarNav ws={ws} />
        </div>
        <div className="border-t border-line-subtle px-4 py-4">
          <WorkspaceSwitch ws={ws} />
        </div>
      </aside>

      {/* Mobile drawer */}
      {mobileOpen ? (
        <div className="no-print fixed inset-0 z-40 md:hidden">
          <button type="button" aria-label="Close menu" className="absolute inset-0 bg-scrim" onClick={() => setMobileOpen(false)} />
          <aside role="dialog" aria-modal="true" aria-label="Navigation" className="relative flex h-full w-[272px] max-w-[85vw] flex-col border-r border-line bg-surface shadow-pop">
            <div className="flex h-16 items-center justify-between px-4">
              <Link href="/" prefetch={false} aria-label="SiteSentry home" onClick={() => setMobileOpen(false)}><Logo /></Link>
              <button type="button" onClick={() => setMobileOpen(false)} className="rounded p-1.5 text-fg-3 hover:bg-hover hover:text-fg" aria-label="Close menu">
                <X className="size-4" />
              </button>
            </div>
            <div className="px-3">
              <SiteSwitcher />
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <SidebarNav ws={ws} onNavigate={() => setMobileOpen(false)} />
            </div>
            <div className="border-t border-line-subtle p-3">
              <WorkspaceSwitch ws={ws} />
            </div>
          </aside>
        </div>
      ) : null}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-2 border-b border-line bg-surface/85 px-4 backdrop-blur-md md:gap-3 md:px-8">
          <button type="button" onClick={() => setMobileOpen(true)} className="-ml-1 rounded p-1.5 text-fg-2 hover:bg-hover hover:text-fg md:hidden" aria-label="Open menu">
            <Menu className="size-5" />
          </button>
          <Link href="/" prefetch={false} className="md:hidden" aria-label="SiteSentry home">
            <Logo compact />
          </Link>
          <button
            type="button"
            onClick={() => setPalette(true)}
            className="ml-auto flex h-10 shrink-0 items-center gap-2.5 rounded-[10px] border border-line bg-surface-secondary px-3 text-sm text-fg-3 transition-colors hover:border-line-strong hover:bg-surface hover:text-fg-2 md:ml-0 lg:w-[380px]"
            aria-keyshortcuts="Control+K"
          >
            <Search className="size-4 shrink-0" aria-hidden />
            {/* The visible text is the accessible name; below lg it is screen-reader only. */}
            <span className="sr-only truncate lg:not-sr-only">Search sites and pages</span>
            <kbd className="ml-auto hidden shrink-0 whitespace-nowrap rounded-md border border-line bg-surface px-1.5 py-0.5 font-sans text-[11px] text-fg-3 lg:inline">Ctrl K</kbd>
          </button>
          <div className="hidden flex-1 md:block" />
          <ThemeToggle />
          <LinkButton href={newAuditHref} variant="primary" size="sm" icon={Plus} className="md:h-10 md:rounded-[10px] md:px-4 md:text-sm">
            <span className="hidden sm:inline">New audit</span>
            <span className="sm:hidden">Audit</span>
          </LinkButton>
        </header>

        {ws === "sample" ? (
          <div className="no-print flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-sample/20 bg-sample-soft px-4 py-2 text-[13px] md:px-8">
            <span className="flex items-center gap-1.5 font-medium text-sample">
              <FlaskConical className="size-4" aria-hidden />
              Sample workspace
            </span>
            <span className="text-fg-2">Two fictional sites with deterministic results. Nothing here is a real scan.</span>
            <Link href="/live" prefetch={false} className="text-fg underline decoration-line underline-offset-4 hover:decoration-fg sm:ml-auto">
              Go to my sites
            </Link>
          </div>
        ) : null}

        <main id="main" className="mx-auto w-full max-w-[1360px] flex-1 px-4 pb-16 pt-6 md:px-8 md:pt-8">
          {children}
        </main>
      </div>

      <CommandPalette open={palette} onClose={() => setPalette(false)} />
      <ShortcutSheet />
    </div>
  );
}

/** Static frame shown while the route params resolve (this is what prerenders). */
function ShellFallback() {
  return (
    <div className="flex min-h-dvh">
      <aside className="hidden w-[252px] shrink-0 border-r border-line bg-surface md:block">
        <div className="flex h-16 items-center px-5"><Logo /></div>
      </aside>
      <div className="flex-1">
        <div className="h-16 border-b border-line bg-surface" />
        <div className="mx-auto max-w-[1360px] px-4 pt-6 md:px-8 md:pt-8"><PageSkeleton /></div>
      </div>
    </div>
  );
}

function ResolvedShell({ params, children }: { params: Promise<{ ws: string }>; children: ReactNode }) {
  const { ws } = use(params);
  if (ws !== "live" && ws !== "sample") notFound();
  return (
    <WorkspaceProvider ws={ws}>
      <Shell ws={ws}>{children}</Shell>
    </WorkspaceProvider>
  );
}

export function AppShell({ params, children }: { params: Promise<{ ws: string }>; children: ReactNode }) {
  return (
    <ToastProvider>
      {/* Provider and shell resolve inside one boundary so their data and markup hydrate together. */}
      <Suspense fallback={<ShellFallback />}>
        <ResolvedShell params={params}>{children}</ResolvedShell>
      </Suspense>
    </ToastProvider>
  );
}
