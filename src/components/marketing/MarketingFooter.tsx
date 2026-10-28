import Link from "next/link";
import { Logo } from "../Logo";
import { MARKETING_LINKS } from "./links";

export function MarketingFooter() {
  return (
    <footer className="border-t border-line bg-surface">
      <div className="mx-auto grid max-w-6xl gap-8 px-4 py-12 sm:px-6 md:grid-cols-[1.4fr_1fr_1fr]">
        <div>
          <Logo />
          <p className="mt-3 max-w-sm text-sm text-fg-2">Technical SEO audits that end in verified fixes: evidence for every finding, acceptance criteria for every task, and a re-check that proves the result.</p>
        </div>
        <nav aria-label="Footer">
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-3">Product</p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            {MARKETING_LINKS.map((l) => (
              <li key={l.href}>
                <Link href={l.href} className="text-fg-2 hover:text-fg">
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-3">Workspace</p>
          <ul className="mt-3 flex flex-col gap-2 text-sm">
            <li><Link href="/live" className="text-fg-2 hover:text-fg">My sites</Link></li>
            <li><Link href="/sample" className="text-fg-2 hover:text-fg">Sample workspace</Link></li>
            <li><Link href="/live/audits/new" className="text-fg-2 hover:text-fg">New audit</Link></li>
          </ul>
        </div>
      </div>
      <div className="border-t border-line-subtle">
        <p className="mx-auto max-w-6xl px-4 py-5 text-xs text-fg-3 sm:px-6">SiteSentry reports what it can observe in fetched HTML. It does not render JavaScript or measure rankings.</p>
      </div>
    </footer>
  );
}
