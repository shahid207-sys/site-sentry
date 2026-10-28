// Static sections of the public site. Every capability described here exists in the workspace today.
import Link from "next/link";
import {
  ArrowRight,
  BadgeCheck,
  Building2,
  Code2,
  FileDown,
  Globe,
  ListChecks,
  MessageSquareText,
  ScanSearch,
  SearchCheck,
  Telescope,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { LinkButton } from "../ui";

// ui.tsx is a client module, so its cx() can't be called while rendering these server components.
const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export function Container({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("mx-auto max-w-[1400px] px-4 sm:px-6 lg:px-8", className)}>{children}</div>;
}

export function SectionHeading({ eyebrow, title, children, id, center }: { eyebrow?: string; title: string; children?: ReactNode; id?: string; center?: boolean }) {
  return (
    <div className={cx("max-w-2xl", center && "mx-auto text-center")}>
      {eyebrow ? <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent-ink">{eyebrow}</p> : null}
      <h2 id={id} className="mt-3 text-3xl font-semibold tracking-[-0.025em] text-fg sm:text-[2.5rem] sm:leading-[1.12]">
        {title}
      </h2>
      {children ? <p className="mt-3 text-base leading-relaxed text-fg-2 sm:text-lg">{children}</p> : null}
    </div>
  );
}

export function Section({ children, className, labelledBy, id }: { children: ReactNode; className?: string; labelledBy?: string; id?: string }) {
  return (
    <section id={id} aria-labelledby={labelledBy} className={cx("scroll-mt-20 py-16 sm:py-24", className)}>
      {children}
    </section>
  );
}

// ---------- workflow ----------

const STEPS: { icon: LucideIcon; title: string; body: string; step: string }[] = [
  { step: "01", icon: ScanSearch, title: "Scan", body: "Enter a website or supported sitemap and inspect public pages safely." },
  { step: "02", icon: Telescope, title: "Understand", body: "See clear explanations, evidence, affected pages and why each issue needs attention." },
  { step: "03", icon: ListChecks, title: "Take Action", body: "Create developer-ready tasks, specify acceptance criteria and track the fix." },
  { step: "04", icon: BadgeCheck, title: "Verify", body: "Rescan and confirm the fix worked. Identify unresolved findings and new regressions." },
];

export function WorkflowSteps({ cta = true }: { cta?: boolean }) {
  return (
    <div>
      <ol className="grid gap-8 sm:grid-cols-2 lg:grid-cols-4 lg:gap-6">
        {STEPS.map((s, i) => (
          <li key={s.title} className="relative flex flex-col items-center text-center">
            <span className="relative grid size-20 place-items-center rounded-full border border-accent/20 bg-accent-softer">
              <span className="grid size-14 place-items-center rounded-full bg-surface text-accent-ink shadow-raised">
                <s.icon className="size-6" aria-hidden />
              </span>
              <span className="absolute -right-1 -top-1 grid size-7 place-items-center rounded-full bg-accent text-xs font-semibold text-accent-fg shadow-[0_4px_10px_-3px_rgb(241_95_70/0.6)]">{i + 1}</span>
            </span>
            {i < STEPS.length - 1 ? (
              <span className="pointer-events-none absolute left-[calc(50%+56px)] right-[calc(-50%+56px)] top-10 hidden items-center lg:flex" aria-hidden>
                <span className="h-px flex-1 border-t-2 border-dashed border-accent/30" />
                <ArrowRight className="-ml-1 size-4 text-accent/60" />
              </span>
            ) : null}
            <h3 className="mt-5 text-lg font-semibold text-fg">{s.title}</h3>
            <p className="mt-2 max-w-[260px] text-sm leading-relaxed text-fg-2">{s.body}</p>
          </li>
        ))}
      </ol>
      {cta ? (
        <div className="mt-12 flex flex-wrap justify-center gap-3">
          <LinkButton href="/#audit" variant="primary" className="h-11 px-6 text-base">
            Run a free audit
          </LinkButton>
          <LinkButton href="/sample-audit" className="h-11 px-6 text-base">
            See a sample audit
          </LinkButton>
        </div>
      ) : null}
    </div>
  );
}

// ---------- features ----------

const FEATURES: { icon: LucideIcon; title: string; detail: string; href: string }[] = [
  {
    icon: SearchCheck,
    title: "Technical SEO audits",
    detail: "Crawl public pages safely and find technical issues, each backed by the HTML and HTTP responses SiteSentry actually received.",
    href: "/sample-audit",
  },
  {
    icon: MessageSquareText,
    title: "Plain-language explanations",
    detail: "Every finding says what was observed, why it matters and what to change, in plain words. Hypotheses are labelled and kept apart from measurements.",
    href: "/methodology",
  },
  {
    icon: ListChecks,
    title: "Fix queue",
    detail: "Turn findings into developer-ready tasks with an owner, notes and frozen acceptance criteria, then track them to done.",
    href: "/sample/tasks",
  },
  {
    icon: BadgeCheck,
    title: "Verification and comparison",
    detail: "Re-fetch a fixed page and judge it against its criteria. Compare audits to see what was resolved, what regressed and what wasn't re-checked.",
    href: "/how-it-works",
  },
  {
    icon: Globe,
    title: "Multi-site workspace",
    detail: "Keep several websites, their important URLs, audit history and outstanding work in one place.",
    href: "/sample/sites",
  },
  {
    icon: FileDown,
    title: "Reports and exports",
    detail: "Hand off audit summaries and developer briefs as CSV, JSON or a print-friendly report.",
    href: "/sample/reports",
  },
];

export function FeatureGrid() {
  return (
    <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {FEATURES.map((f) => (
        <Link
          key={f.title}
          href={f.href}
          className="group flex flex-col rounded-2xl border border-line bg-surface p-6 shadow-card transition-[transform,border-color,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-raised"
        >
          <span className="grid size-12 place-items-center rounded-xl bg-accent-soft text-accent-ink transition-colors group-hover:bg-accent group-hover:text-accent-fg">
            <f.icon className="size-6" aria-hidden />
          </span>
          <h3 className="mt-5 text-lg font-semibold text-fg">{f.title}</h3>
          <p className="mt-2 flex-1 text-sm leading-relaxed text-fg-2">{f.detail}</p>
          <span className="mt-5 inline-flex items-center gap-1 text-[13px] font-semibold text-accent-ink">
            Learn more
            <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" aria-hidden />
          </span>
        </Link>
      ))}
    </div>
  );
}

// ---------- verification ----------

const WORKFLOW = ["Open", "Triaged", "In progress", "Ready to verify", "Resolved"];
const OUTCOMES: { label: string; tone: string; body: string }[] = [
  { label: "Passing", tone: "bg-ok-soft text-ok", body: "Every acceptance criterion holds on the live page." },
  { label: "Failing", tone: "bg-sev-high-soft text-sev-high", body: "At least one criterion still fails. The task stays open." },
  { label: "Inconclusive", tone: "bg-sev-medium-soft text-sev-medium", body: "The page timed out, was blocked or was truncated. Never counted as fixed." },
];

export function VerificationFlow() {
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-fg-3">Set by your team</p>
        <h3 className="mt-1 text-xl font-semibold text-fg">Workflow status</h3>
        <p className="mt-2 text-sm text-fg-2">Where the work is. Moving a task to &ldquo;Resolved&rdquo; records a decision; it doesn&apos;t prove anything about the site.</p>
        <ol className="mt-5 flex flex-wrap items-center gap-2 text-sm">
          {WORKFLOW.map((w, i) => (
            <li key={w} className="flex items-center gap-2">
              <span className="rounded-md border border-line bg-elevated px-2.5 py-1 text-fg">{w}</span>
              {i < WORKFLOW.length - 1 ? <ArrowRight className="size-3.5 text-fg-3" aria-hidden /> : null}
            </li>
          ))}
        </ol>
      </div>
      <div className="rounded-2xl border border-line bg-surface p-6 shadow-card">
        <p className="text-xs font-semibold uppercase tracking-[0.08em] text-accent-ink">Set only by SiteSentry</p>
        <h3 className="mt-1 text-xl font-semibold text-fg">Verification status</h3>
        <p className="mt-2 text-sm text-fg-2">What the live page actually shows when it is re-fetched and judged against the task&apos;s frozen criteria.</p>
        <ul className="mt-5 grid gap-3">
          {OUTCOMES.map((o) => (
            <li key={o.label} className="flex items-start gap-3 text-sm">
              <span className={cx("w-[104px] shrink-0 rounded-md px-2 py-0.5 text-center text-xs font-medium", o.tone)}>{o.label}</span>
              <span className="text-fg-2">{o.body}</span>
            </li>
          ))}
        </ul>
      </div>
      <p className="text-sm text-fg-2 lg:col-span-2">
        Between audits the same rule applies: an issue counts as <span className="font-medium text-fg">resolved</span> only when a later audit re-examined its page and check and no longer found it. If the later audit skipped the page, the issue is shown as <span className="font-medium text-fg">not re-checked</span>, not fixed.
      </p>
    </div>
  );
}

// ---------- use cases ----------

const USE_CASES: { icon: LucideIcon; who: string; body: string }[] = [
  { icon: SearchCheck, who: "Technical SEO specialists", body: "Audit a site, read the evidence behind every finding, and spend your time on the ones that are both severe and certain." },
  { icon: Building2, who: "Agencies", body: "Run several client sites from one workspace, export what you found, and show clients which fixes were verified after each release." },
  { icon: Code2, who: "Developers", body: "Get tasks with the offending HTML, the expected result and a check you can re-run yourself, instead of a screenshot in a ticket." },
];

export function UseCases() {
  return (
    <div className="grid gap-4 md:grid-cols-3">
      {USE_CASES.map((u) => (
        <article key={u.who} className="rounded-2xl border border-line bg-surface p-6 shadow-card">
          <u.icon className="size-6 text-accent-ink" aria-hidden />
          <h3 className="mt-4 text-lg font-semibold text-fg">{u.who}</h3>
          <p className="mt-2 text-sm leading-relaxed text-fg-2">{u.body}</p>
        </article>
      ))}
    </div>
  );
}

// ---------- trust ----------

export function TrustSummary() {
  const cols: { title: string; items: string[] }[] = [
    { title: "What it observes", items: ["The HTML and headers each page returns", "robots.txt, XML sitemaps and redirect chains", "The status of internal link and image targets"] },
    { title: "What it marks as unknown", items: ["Pages that timed out, failed or were blocked", "Pages over the size limit (truncated)", "Issues the latest audit didn't re-examine"] },
    { title: "What it doesn't claim", items: ["Content added by JavaScript after load", "Rankings, traffic or Core Web Vitals field data", "That a change caused a ranking movement"] },
  ];
  return (
    <div className="grid gap-px overflow-hidden rounded-2xl border border-line bg-line md:grid-cols-3">
      {cols.map((c) => (
        <div key={c.title} className="bg-surface p-6">
          <h3 className="text-base font-semibold text-fg">{c.title}</h3>
          <ul className="mt-3 space-y-2 text-sm text-fg-2">
            {c.items.map((i) => (
              <li key={i} className="flex gap-2">
                <span className="mt-2 size-1.5 shrink-0 rounded-full bg-line-strong" aria-hidden />
                {i}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ---------- FAQ ----------

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: "What happens when I run a quick audit?",
    a: <>SiteSentry adds the site to your workspace and inspects up to 10 pages, one click deep from the address you entered. You watch it run page by page, then land on the results. For larger crawls, URL lists or sitemaps, use <Link href="/live/audits/new" className="underline underline-offset-4">New audit</Link> in the workspace.</>,
  },
  { q: "Is the sample audit real?", a: "The websites are fictional and bundled with SiteSentry, but every finding, task and verification result in the sample was produced by the same engine that audits real sites. Sample data is labelled everywhere and never mixed into your own numbers." },
  { q: "Does SiteSentry render JavaScript?", a: "No. It reads the HTML the server returns, as a crawler does on first fetch. Content inserted later by client-side JavaScript isn't seen, and the methodology page says which checks that affects." },
  { q: "Can it prove that a fix improved my rankings?", a: "No. It can prove the page now meets the criteria the fix was meant to satisfy. Whether rankings move depends on things page HTML can't show; search-performance data would be needed for that." },
  { q: "Which addresses can it fetch?", a: "Only public http and https sites on standard ports. Private, loopback and cloud-metadata addresses are refused, every redirect is re-checked, and response sizes and timeouts are capped." },
  { q: "Who can see my workspace?", a: "This deployment has no user accounts: anyone who can reach it shares the same workspace. Run it privately for client work." },
];

export function FAQSection() {
  return (
    <div className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface shadow-card">
      {FAQ.map((f) => (
        <details key={f.q} className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-6 py-5 text-left text-base font-medium text-fg hover:bg-surface-secondary [&::-webkit-details-marker]:hidden">
            {f.q}
            <span aria-hidden className="grid size-6 shrink-0 place-items-center rounded-full border border-line text-fg-3 transition-transform group-open:rotate-45">
              +
            </span>
          </summary>
          <div className="px-6 pb-5 text-sm leading-relaxed text-fg-2">{f.a}</div>
        </details>
      ))}
    </div>
  );
}

// ---------- closing CTA ----------

export function FinalCta({ title = "See what your site is actually serving.", body = "Run a quick audit on a public URL, or explore the sample workspace first." }: { title?: string; body?: string }) {
  return (
    <Section labelledBy="cta-heading">
      <Container>
        <div className="relative overflow-hidden rounded-3xl bg-[#172033] px-6 py-14 text-center sm:px-12">
          <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(60%_80%_at_50%_0%,rgb(241_95_70/0.35),transparent_70%)]" aria-hidden />
          <h2 id="cta-heading" className="relative mx-auto max-w-2xl text-3xl font-semibold tracking-[-0.02em] text-white sm:text-4xl">
            {title}
          </h2>
          <p className="relative mx-auto mt-3 max-w-xl text-base text-white/75">{body}</p>
          <div className="relative mt-8 flex flex-wrap justify-center gap-3">
            <LinkButton href="/#audit" variant="primary" className="h-11 px-5 text-base">
              Run a quick audit
            </LinkButton>
            <LinkButton href="/sample-audit" className="h-11 border-white/20 bg-white/10 px-5 text-base text-white hover:border-white/40 hover:bg-white/15">
              Explore the sample audit
            </LinkButton>
          </div>
        </div>
      </Container>
    </Section>
  );
}
