// Brand mark shared by the public site and the workspace.
export function Logo({ compact }: { compact?: boolean }) {
  return (
    <span className="flex items-center gap-2.5">
      <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-gradient-to-br from-[#ff7a5c] to-accent text-accent-fg shadow-[0_4px_10px_-3px_rgb(241_95_70/0.55)]">
        <svg viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.2 7.5 9.5 4.3-1.3 7.5-4.9 7.5-9.5V6L12 3Z" />
          <path d="m8.8 12.2 2.3 2.3 4.3-4.6" />
        </svg>
      </span>
      {!compact ? <span className="text-base font-semibold tracking-[-0.01em] text-fg">SiteSentry</span> : null}
    </span>
  );
}
