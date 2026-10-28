"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowUpRight, Menu, X } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { Logo } from "../Logo";
import { cx, LinkButton } from "../ui";
import { MARKETING_LINKS } from "./links";

export function MarketingNavbar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const menuId = useId();

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- close the menu after navigating
    setOpen(false);
  }, [pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="sticky top-0 z-40 border-b border-line/80 bg-surface/80 backdrop-blur-xl">
      <a href="#content" className="sr-only z-50 rounded bg-accent px-3 py-2 text-accent-fg focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </a>
      <div className="mx-auto flex h-20 max-w-[1400px] items-center gap-4 px-4 sm:px-6 lg:px-8">
        <Link href="/" aria-label="SiteSentry home">
          <Logo />
        </Link>
        <nav aria-label="Main" className="ml-4 hidden lg:block">
          <ul className="flex items-center gap-0.5">
            {MARKETING_LINKS.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  aria-current={pathname === l.href ? "page" : undefined}
                  className={cx("rounded-full px-4 py-2 text-base font-medium transition-colors", pathname === l.href ? "bg-accent-soft text-accent-ink" : "text-fg-2 hover:bg-hover hover:text-fg")}
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ml-auto hidden items-center gap-2 lg:flex">
          <Link href="/live" aria-label="Open workspace" className="inline-flex items-center gap-1 rounded-full px-4 py-2 text-base font-medium text-fg-2 hover:bg-hover hover:text-fg">
            Open workspace
            <ArrowUpRight className="size-3.5" aria-hidden />
          </Link>
          <LinkButton href="/#audit" variant="primary" className="h-11 rounded-full px-6 text-base">
            Run a free audit
          </LinkButton>
        </div>
        <button
          type="button"
          className="-mr-1.5 ml-auto rounded-md p-2 text-fg-2 hover:bg-hover hover:text-fg lg:hidden"
          aria-expanded={open}
          aria-controls={menuId}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? <X className="size-5" aria-hidden /> : <Menu className="size-5" aria-hidden />}
          <span className="sr-only">{open ? "Close menu" : "Open menu"}</span>
        </button>
      </div>
      {open ? (
        <div id={menuId} className="border-t border-line bg-surface px-4 pb-5 pt-2 shadow-pop lg:hidden">
          <nav aria-label="Main">
            <ul className="flex flex-col">
              {MARKETING_LINKS.map((l) => (
                <li key={l.href}>
                  <Link href={l.href} aria-current={pathname === l.href ? "page" : undefined} className="block rounded-md px-2 py-3 text-base text-fg hover:bg-hover">
                    {l.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <div className="mt-3 grid gap-2">
            <LinkButton href="/#audit" variant="primary" className="h-11 text-base">
              Run a free audit
            </LinkButton>
            <LinkButton href="/live" className="h-11 text-base">
              Open workspace
            </LinkButton>
          </div>
        </div>
      ) : null}
    </header>
  );
}
