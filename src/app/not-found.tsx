import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-dvh place-items-center px-4 text-center">
      <div>
        <p className="font-mono text-sm text-accent-ink">404</p>
        <h1 className="mt-2 text-xl font-semibold text-fg">Page not found</h1>
        <p className="mt-1 text-sm text-fg-2">This address doesn&apos;t match anything in SiteSentry.</p>
        <div className="mt-5 flex flex-wrap justify-center gap-2">
          <Link href="/" className="inline-flex h-9 items-center rounded-md bg-accent px-3.5 text-sm font-semibold text-accent-fg hover:bg-accent-hover">
            SiteSentry home
          </Link>
          <Link href="/live" className="inline-flex h-9 items-center rounded-md border border-line bg-surface px-3.5 text-sm text-fg hover:bg-elevated">
            Open workspace
          </Link>
        </div>
      </div>
    </main>
  );
}
