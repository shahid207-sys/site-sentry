# Phase 4: UI/UX rebuild: decisions and conflicts

This document records the UI rebuild's decisions where docs/SPEC.md and the existing codebase disagree. The
non-negotiables say to stop and report such a conflict with two options; the owner asked for the phases to be
completed without further questions. So each conflict below is recorded with both options, the choice made and
why. Any of these can be reversed.

## Spec vs codebase conflicts

| # | SPEC says | Codebase had | Option A | Option B | Chosen |
| --- | --- | --- | --- | --- | --- |
| 1 | shadcn/ui (Radix primitives) | Hand-written primitives in `src/components/ui.tsx` and `overlays.tsx` (native `<dialog>` modal and drawer, with focus trap and Esc) used by every screen | Adopt shadcn/Radix and port every screen | Keep `ui.tsx` / `overlays.tsx` and extend them | **B**: the non-negotiables say to reuse the existing stack. The native `<dialog>` already gives focus trapping and inert backgrounds, and adding Radix would mean two component systems side by side |
| 2 | TanStack Table (virtualised) | No table library | `@tanstack/react-table` + `@tanstack/react-virtual` | `@tanstack/react-virtual` only, with a small typed `VirtualTable` (`src/components/v2/VirtualTable.tsx`) | **B**: virtualisation is what the 50k-row target needs. Sorting, filtering and column choice are a few lines of typed code, which doesn't justify a second dependency |
| 3 | Recharts or visx for charts; Sigma.js/Graphology for the link graph | No chart library | Add Recharts and Sigma/Graphology | Plain SVG and CSS for the bar, funnel and histogram charts, and no link graph | **B** for charts: each chart is a few rects. **The interactive link graph (screen 8) is not built** and is listed as not done, with no placeholder panel |
| 4 | Framer Motion for restrained transitions | CSS transitions plus a `prefers-reduced-motion` override in `globals.css` | Add Framer Motion | CSS only | **B**: the spec's 150–200 ms ease-out transitions are CSS one-liners. Numbers never animate on filter changes |
| 5 | Inter for UI, JetBrains Mono for code | Geist and Geist Mono | Switch the fonts | Keep Geist | **A**: same mechanism (`next/font`), no new dependency (commit e1b8906) |
| 6 | Severity: Critical, High, Medium, Low, Info, Passed | Legacy findings use three severities (high/medium/low); Phase 3 groups use five priorities (critical…info) | Map the legacy findings onto five levels | Keep legacy views on three severities, and use five priority levels plus "Resolved" (passed) on every v2 screen | **B**: legacy audits keep the meaning they were computed with. The v2 screens use the spec scale, with icon and label tokens (`--p-*`) |
| 7 | Full dark mode from day one | Light only | Dark tokens plus a theme toggle | Light only | **A**: the same token names are redefined under `prefers-color-scheme` and `html[data-theme]`. Contrast is unit-tested in both themes (`src/app/tokens.test.ts`) |
| 8 | Workspaces with roles; audit log of who marked what | No user accounts | Build auth and roles now | Log triage changes with the actor "local user" until accounts exist (Phase 6, collaboration) | **B**: building accounts is outside Phase 4. `triage_events` already stores the actor, so accounts will slot in |

## Found along the way

- **Primary buttons failed WCAG AA.** White on the coral accent fill was 3.2:1, although `globals.css` claimed
  6.4:1. The fill is now `#cf3f27` (4.8:1). The brighter brand coral remains only as decoration.
- **Typecheck was failing in CI.** `vitest.coverage.config.mts` imported a `.mts` path, which tsc rejects (TS5097),
  so CI's `npm run typecheck` step would have failed since commit c1ad7cd. Fixed in 286863d.

## Triage is a claim, not a result

Mark fixed, ignore with a reason, assign, and the Fix board columns are stored in `issue_triage`. Every change is
also logged in `triage_events`. Triage never changes `issue_states`, the counts or the health score. Those come
only from crawls, so "report counts = DB counts" (gate:p3) keeps its meaning. The board's **Verified** column is
earned only when a fix verification (a targeted re-crawl) resolved the group and nothing in it is open. It cannot
be set by hand. `src/lib/results/triage.int.test.ts` checks all of this.

## Sample workspace

The sample workspace's audits are deterministic in-memory runs of the legacy engine, with no crawler v2 crawl.
They keep the legacy screens. The v2 screens (sub-routes of `/live/audits/<id>/…`) apply to live audits run with
`CRAWLER_V2=true`.
