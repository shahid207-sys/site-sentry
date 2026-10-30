"use client";
// Design-system primitives. Every status is shown with an icon AND text, never colour alone.
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowUpRight,
  Ban,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  CircleX,
  Clock,
  FlaskConical,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { forwardRef, useId, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import type { ChangeKind } from "@/lib/audit/compare";
import type { Certainty, FindingKind, Severity } from "@/lib/audit/types";
import type { AuditStatus, VerificationStatus, WorkflowStatus } from "@/lib/model";
import { CHANGE_LABELS } from "@/lib/views";
import type { ApiError } from "./lib/api";
import { useWsOptional } from "./shell/context";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

// ---------- buttons ----------

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary: "bg-accent text-accent-fg hover:bg-accent-hover font-semibold shadow-[0_1px_2px_rgb(16_24_40/0.08),0_4px_12px_-4px_rgb(241_95_70/0.45)]",
  secondary: "bg-surface text-fg font-medium border border-line shadow-[0_1px_2px_rgb(16_24_40/0.05)] hover:bg-surface-secondary hover:border-line-strong",
  ghost: "text-fg-2 font-medium hover:text-fg hover:bg-hover",
  danger: "bg-surface text-sev-high font-medium border border-line hover:bg-sev-high-soft hover:border-sev-high/40",
};
const SIZE: Record<Size, string> = { sm: "h-8 px-3 text-[13px] gap-1.5 rounded-lg", md: "h-10 px-4 text-sm gap-2 rounded-[10px]" };

export const btn = (variant: Variant = "secondary", size: Size = "md", extra?: string) =>
  cx(
    "inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-[background-color,border-color,color,box-shadow] duration-150 disabled:pointer-events-none disabled:opacity-50 [&_svg]:size-4 [&_svg]:shrink-0",
    VARIANT[variant],
    SIZE[size],
    extra,
  );

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: LucideIcon;
  loading?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant, size, icon: Icon, loading, className, children, disabled, ...rest }, ref) {
  return (
    <button ref={ref} type="button" className={btn(variant, size, className)} disabled={disabled || loading} aria-busy={loading || undefined} {...rest}>
      {loading ? <LoaderCircle className="animate-spin" aria-hidden /> : Icon ? <Icon aria-hidden /> : null}
      {children}
    </button>
  );
});

export function LinkButton({ href, variant, size, icon: Icon, children, className, ...rest }: { href: string; variant?: Variant; size?: Size; icon?: LucideIcon; children: ReactNode; className?: string; download?: string; target?: string }) {
  return (
    <Link href={href} className={btn(variant, size, className)} prefetch={false} {...rest}>
      {Icon ? <Icon aria-hidden /> : null}
      {children}
    </Link>
  );
}

// ---------- badges ----------

function Pill({ icon: Icon, tone, children, title, className }: { icon?: LucideIcon; tone: string; children: ReactNode; title?: string; className?: string }) {
  return (
    <span title={title} className={cx("inline-flex h-6 shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 text-xs font-medium [&_svg]:size-3.5", tone, className)}>
      {Icon ? <Icon aria-hidden /> : null}
      {children}
    </span>
  );
}

const SEV: Record<Severity, { tone: string; icon: LucideIcon; label: string }> = {
  high: { tone: "bg-sev-high-soft text-sev-high", icon: CircleAlert, label: "High" },
  medium: { tone: "bg-sev-medium-soft text-sev-medium", icon: TriangleAlert, label: "Medium" },
  low: { tone: "bg-sev-low-soft text-sev-low", icon: CircleDashed, label: "Low" },
};

export function SeverityBadge({ severity, priority }: { severity: Severity; priority?: number }) {
  const s = SEV[severity];
  return (
    <Pill icon={s.icon} tone={s.tone} title={priority ? `Priority P${priority}, severity ${s.label.toLowerCase()}` : undefined}>
      {priority ? <span className="tabular">P{priority}</span> : null}
      {priority ? <span className="opacity-60">·</span> : null}
      {s.label}
    </Pill>
  );
}

export function SeverityDot({ severity }: { severity: Severity }) {
  const Icon = SEV[severity].icon;
  return <Icon className={cx("size-3.5 shrink-0", SEV[severity].tone.split(" ")[1])} aria-label={`${SEV[severity].label} severity`} />;
}

const CERTAINTY: Record<Certainty, { label: string; title: string }> = {
  verified: { label: "Verified", title: "Measured directly from the response" },
  heuristic: { label: "Heuristic", title: "Based on a configurable threshold or convention" },
  needs_review: { label: "Needs review", title: "Correctly measured, but may be intentional" },
};

export function CertaintyBadge({ certainty }: { certainty: Certainty }) {
  const c = CERTAINTY[certainty];
  return (
    <Pill tone="border border-line text-fg-2" title={c.title} icon={certainty === "verified" ? CircleCheck : certainty === "heuristic" ? CircleDashed : CircleQuestionMark}>
      {c.label}
    </Pill>
  );
}

const KIND: Record<FindingKind, string> = { defect: "Defect", warning: "Warning", opportunity: "Opportunity", observation: "Observation" };
export const KindBadge = ({ kind }: { kind: FindingKind }) => <Pill tone="border border-line text-fg-2">{KIND[kind]}</Pill>;

const AUDIT_STATUS: Record<AuditStatus | "stale", { tone: string; icon: LucideIcon; label: string }> = {
  running: { tone: "bg-info-soft text-info", icon: LoaderCircle, label: "Running" },
  stale: { tone: "bg-sev-medium-soft text-sev-medium", icon: Clock, label: "Interrupted" },
  completed: { tone: "bg-ok-soft text-ok", icon: CircleCheck, label: "Completed" },
  completed_empty: { tone: "bg-sev-medium-soft text-sev-medium", icon: CircleDashed, label: "Completed, nothing analysed" },
  partial: { tone: "bg-sev-medium-soft text-sev-medium", icon: CircleDashed, label: "Partial" },
  failed: { tone: "bg-sev-high-soft text-sev-high", icon: CircleX, label: "Failed" },
  cancelled: { tone: "bg-elevated text-fg-2 border border-line", icon: Ban, label: "Cancelled" },
};

export function AuditStatusBadge({ status, stale }: { status: AuditStatus; stale?: boolean }) {
  const s = AUDIT_STATUS[stale && status === "running" ? "stale" : status];
  return (
    <Pill icon={s.icon} tone={s.tone} className={status === "running" && !stale ? "[&_svg]:animate-spin" : undefined}>
      {s.label}
    </Pill>
  );
}

const WORKFLOW: Record<WorkflowStatus, { tone: string; icon: LucideIcon; label: string }> = {
  open: { tone: "border border-line text-fg", icon: CircleDashed, label: "Open" },
  triaged: { tone: "border border-line text-fg-2", icon: CircleQuestionMark, label: "Triaged" },
  in_progress: { tone: "bg-info-soft text-info", icon: LoaderCircle, label: "In progress" },
  ready_to_verify: { tone: "bg-accent-soft text-accent-ink", icon: RefreshCw, label: "Ready to verify" },
  resolved: { tone: "bg-ok-soft text-ok", icon: CircleCheck, label: "Resolved" },
  wont_fix: { tone: "bg-elevated text-fg-3 border border-line", icon: Ban, label: "Won't fix" },
};
export function WorkflowBadge({ status }: { status: WorkflowStatus }) {
  const s = WORKFLOW[status];
  return (
    <Pill icon={s.icon} tone={s.tone} title="Workflow status (set by people)">
      {s.label}
    </Pill>
  );
}

const VERIFY: Record<VerificationStatus, { tone: string; icon: LucideIcon; label: string }> = {
  unverified: { tone: "text-fg-3", icon: CircleDashed, label: "Not verified" },
  passing: { tone: "bg-ok-soft text-ok", icon: CircleCheck, label: "Passing" },
  failing: { tone: "bg-sev-high-soft text-sev-high", icon: CircleX, label: "Failing" },
  inconclusive: { tone: "bg-sev-medium-soft text-sev-medium", icon: CircleQuestionMark, label: "Inconclusive" },
  partial: { tone: "bg-sev-medium-soft text-sev-medium", icon: CircleDashed, label: "Partly passing" },
};
export function VerificationBadge({ status }: { status: VerificationStatus }) {
  const s = VERIFY[status];
  return (
    <Pill icon={s.icon} tone={s.tone} title="Verification status (set only by re-checking the site)">
      {s.label}
    </Pill>
  );
}

const CHANGE: Record<ChangeKind, { tone: string; icon: LucideIcon }> = {
  regression: { tone: "bg-sev-high-soft text-sev-high", icon: TriangleAlert },
  new: { tone: "bg-accent-soft text-accent-ink", icon: CircleAlert },
  changed: { tone: "bg-info-soft text-info", icon: RefreshCw },
  persistent: { tone: "border border-line text-fg-2", icon: Clock },
  resolved: { tone: "bg-ok-soft text-ok", icon: CircleCheck },
  not_rechecked: { tone: "bg-sev-medium-soft text-sev-medium", icon: CircleQuestionMark },
};
export function ChangeBadge({ kind }: { kind: ChangeKind }) {
  const c = CHANGE[kind];
  return (
    <Pill icon={c.icon} tone={c.tone}>
      {CHANGE_LABELS[kind]}
    </Pill>
  );
}

export function SampleTag({ className }: { className?: string }) {
  return (
    <Pill icon={FlaskConical} tone={cx("bg-sample-soft text-sample", className)} title="Synthetic data from the bundled sample workspace. Not a real website.">
      Sample data
    </Pill>
  );
}

export const Tag = ({ children }: { children: ReactNode }) => <Pill tone="bg-elevated text-fg-2 border border-line-subtle">{children}</Pill>;

// ---------- layout ----------

export interface Crumb {
  label: string;
  href?: string;
}

/**
 * Trail from the workspace root to the current page. The workspace crumb is added automatically;
 * the last crumb is the current page, and a crumb pointing at the current path is not a link.
 */
export function Breadcrumbs({ crumbs, className }: { crumbs: Crumb[]; className?: string }) {
  const wsCtx = useWsOptional();
  const pathname = usePathname();
  const trail: Crumb[] = wsCtx ? [{ label: wsCtx.ws === "sample" ? "Sample workspace" : "Live workspace", href: wsCtx.base }, ...crumbs] : crumbs;
  if (!trail.length) return null;
  return (
    <nav aria-label="Breadcrumb" className={cx("no-print", className)}>
      <ol className="flex flex-wrap items-center gap-1 text-[13px] text-fg-3">
        {trail.map((c, i) => {
          const last = i === trail.length - 1;
          return (
            <li key={i} className="flex min-w-0 max-w-full items-center gap-1">
              {c.href && !last && c.href !== pathname ? (
                <Link href={c.href} prefetch={false} className="truncate rounded-sm hover:text-fg">
                  {c.label}
                </Link>
              ) : (
                <span className={cx("truncate", last ? "text-fg-2" : undefined)} aria-current={last ? "page" : undefined}>
                  {c.label}
                </span>
              )}
              {!last ? <ChevronRight className="size-3.5 shrink-0" aria-hidden /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

export function PageHeader({ title, description, crumbs, actions, meta }: { title: ReactNode; description?: ReactNode; crumbs?: Crumb[]; actions?: ReactNode; meta?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-col gap-4 md:mb-8 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        {crumbs ? <Breadcrumbs crumbs={crumbs} className="mb-2" /> : null}
        <h1 className="text-2xl font-semibold leading-tight tracking-[-0.02em] text-fg md:text-[28px]">{title}</h1>
        {description ? <p className="mt-1.5 max-w-3xl text-[15px] text-fg-2">{description}</p> : null}
        {meta ? <div className="mt-3 flex flex-wrap items-center gap-2">{meta}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A titled region. `flush` removes the inner padding for tables. */
export function Panel({ title, description, actions, children, flush, className, id }: { title?: ReactNode; description?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string; id?: string }) {
  const headingId = useId();
  return (
    <section id={id} className={cx("min-w-0 rounded-2xl border border-line bg-surface shadow-card", className)} aria-labelledby={title ? headingId : undefined}>
      {title || actions ? (
        <div className={cx("flex min-h-14 items-center justify-between gap-x-4 gap-y-2 px-5 pt-4 max-sm:flex-wrap", flush ? "border-b border-line-subtle pb-3.5" : "pb-1")}>
          <div className="min-w-0 flex-1">
            {title ? <h2 id={headingId} className="text-[15px] font-semibold tracking-[-0.01em] text-fg">{title}</h2> : null}
            {description ? <p className="mt-0.5 text-[13px] text-fg-3">{description}</p> : null}
          </div>
          {actions ? <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={flush ? undefined : "px-5 pb-5 pt-3"}>{children}</div>
    </section>
  );
}

export function Notice({ tone = "info", title, children, action }: { tone?: "info" | "warn" | "error" | "ok" | "sample"; title?: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const t = {
    info: { c: "border-info/25 bg-info-soft", i: CircleAlert, ic: "text-info" },
    warn: { c: "border-sev-medium/25 bg-sev-medium-soft", i: TriangleAlert, ic: "text-sev-medium" },
    error: { c: "border-sev-high/30 bg-sev-high-soft", i: CircleX, ic: "text-sev-high" },
    ok: { c: "border-ok/25 bg-ok-soft", i: CircleCheck, ic: "text-ok" },
    sample: { c: "border-sample/25 bg-sample-soft", i: FlaskConical, ic: "text-sample" },
  }[tone];
  const Icon = t.i;
  return (
    <div role={tone === "error" ? "alert" : "status"} className={cx("flex flex-col gap-3 rounded-xl border px-4 py-3 sm:flex-row sm:items-start", t.c)}>
      <Icon className={cx("mt-0.5 size-4 shrink-0", t.ic)} aria-hidden />
      <div className="min-w-0 flex-1 text-sm">
        {title ? <p className="font-medium text-fg">{title}</p> : null}
        {children ? <div className={cx("text-fg-2", !!title && "mt-0.5")}>{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function EmptyState({ icon: Icon, title, children, action, compact }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode; compact?: boolean }) {
  return (
    <div className={cx("flex flex-col items-center text-center", compact ? "px-4 py-8" : "px-6 py-14")}>
      <div className="mb-3 grid size-11 place-items-center rounded-xl bg-accent-soft text-accent-ink">
        <Icon className="size-5" aria-hidden />
      </div>
      <p className="text-sm font-semibold text-fg">{title}</p>
      {children ? <div className="mt-1 max-w-md text-[13px] text-fg-2">{children}</div> : null}
      {action ? <div className="mt-4 flex flex-wrap justify-center gap-2">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry, title }: { error: ApiError | Error; onRetry?: () => void; title?: string }) {
  const status = (error as ApiError).status;
  const heading =
    title ??
    (status === 404 ? "Not found" : status === 403 ? "Not allowed" : status === 0 ? "Server unreachable" : status === 503 ? "Storage unavailable" : status === 429 ? "Slow down" : "Could not load this page");
  return (
    <div className="rounded-2xl border border-sev-high/25 bg-surface">
      <EmptyState icon={CircleX} title={heading} action={onRetry && status !== 404 ? <Button icon={RefreshCw} onClick={onRetry}>Try again</Button> : undefined}>
        {error.message}
      </EmptyState>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton", className)} aria-hidden />;
}

export function PageSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div role="status" aria-label="Loading">
      <Skeleton className="mb-2 h-3.5 w-40" />
      <Skeleton className="mb-8 h-7 w-72" />
      <div className="mb-6 grid grid-cols-2 gap-px overflow-hidden rounded-[10px] border border-line bg-line md:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="bg-surface p-4">
            <Skeleton className="mb-3 h-3 w-20" />
            <Skeleton className="h-6 w-14" />
          </div>
        ))}
      </div>
      <div className="rounded-[10px] border border-line bg-surface">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="flex items-center gap-4 border-b border-line-subtle px-4 py-3.5 last:border-0">
            <Skeleton className="h-4 w-16" />
            <Skeleton className="h-4 flex-1" />
            <Skeleton className="hidden h-4 w-24 sm:block" />
          </div>
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/** A row of key figures, one card each. */
export function StatStrip({ items }: { items: { label: string; value: ReactNode; hint?: ReactNode; href?: string; icon?: LucideIcon; tone?: Tone }[] }) {
  return (
    <dl className={cx("grid gap-3 sm:gap-4", items.length >= 4 ? "grid-cols-2 lg:grid-cols-4" : items.length === 3 ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-2")}>
      {items.map((it) => (
        <StatCard key={it.label} {...it} />
      ))}
    </dl>
  );
}

export type Tone = "accent" | "high" | "medium" | "low" | "ok" | "info" | "neutral" | "sample";

export const TONE: Record<Tone, string> = {
  accent: "bg-accent-soft text-accent-ink",
  high: "bg-sev-high-soft text-sev-high",
  medium: "bg-sev-medium-soft text-sev-medium",
  low: "bg-sev-low-soft text-sev-low",
  ok: "bg-ok-soft text-ok",
  info: "bg-info-soft text-info",
  neutral: "bg-elevated text-fg-2",
  sample: "bg-sample-soft text-sample",
};

/** Rounded square holding an icon on a soft tint. */
export function IconTile({ icon: Icon, tone = "accent", size = "md", className }: { icon: LucideIcon; tone?: Tone; size?: "sm" | "md" | "lg"; className?: string }) {
  return (
    <span className={cx("grid shrink-0 place-items-center", size === "sm" ? "size-8 rounded-lg [&_svg]:size-4" : size === "lg" ? "size-12 rounded-xl [&_svg]:size-6" : "size-10 rounded-[10px] [&_svg]:size-5", TONE[tone], className)} aria-hidden>
      <Icon />
    </span>
  );
}

/**
 * One key figure in its own card, optionally with an icon tile and a link. Renders inside a <dl>: the card is the
 * <div> that groups one dt with its dd's, and a link stretches over the card from inside the dt.
 */
export function StatCard({ label, value, hint, href, icon, tone = "accent" }: { label: string; value: ReactNode; hint?: ReactNode; href?: string; icon?: LucideIcon; tone?: Tone }) {
  return (
    <div className={cx("relative min-w-0 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5", href && "transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-raised")}>
      <dt className="flex items-start justify-between gap-3 text-[13px] font-medium text-fg-2">
        {href ? (
          <Link href={href} prefetch={false} className="after:absolute after:inset-0 after:rounded-2xl">
            {label}
          </Link>
        ) : (
          <span>{label}</span>
        )}
        {icon ? <IconTile icon={icon} tone={tone} size="sm" /> : null}
      </dt>
      <dd className="mt-2 text-[28px] font-semibold leading-none tracking-[-0.02em] text-fg tabular">{value}</dd>
      {hint ? <dd className="mt-2 text-xs text-fg-3">{hint}</dd> : null}
    </div>
  );
}

// ---------- charts (inline SVG, no dependencies) ----------

export const scoreColor = (score: number) => (score >= 80 ? "var(--chart-ok)" : score >= 60 ? "var(--chart-medium)" : "var(--chart-high)");

/** Circular gauge for a 0–100 score. The number is the accessible label. */
export function ScoreRing({ score, size = 112, stroke = 10, label, sublabel }: { score: number; size?: number; stroke?: number; label?: string; sublabel?: ReactNode }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, score)) / 100;
  return (
    <div className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} role="img" aria-label={`${label ?? "Score"}: ${score} out of 100`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--elevated)" strokeWidth={stroke} />
        {pct > 0 ? <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={scoreColor(score)} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={`${c * pct} ${c}`} /> : null}
      </svg>
      <span className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
        <span className="font-semibold leading-none tracking-[-0.03em] text-fg tabular" style={{ fontSize: Math.round(size * 0.3) }}>
          {score}
        </span>
        {sublabel ? <span className="mt-1 text-[11px] font-medium text-fg-3">{sublabel}</span> : null}
      </span>
    </div>
  );
}

/** Donut chart. Zero segments are skipped; the caller renders the legend. */
export function Donut({ segments, size = 128, stroke = 16, center, label }: { segments: { value: number; color: string }[]; size?: number; stroke?: number; center?: ReactNode; label: string }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const total = segments.reduce((n, s) => n + s.value, 0);
  const shown = segments.filter((s) => s.value > 0);
  const gap = shown.length > 1 ? 2 : 0;
  const arcs = shown.map((s, i) => {
    const offset = shown.slice(0, i).reduce((n, x) => n + (x.value / total) * c, 0);
    return { color: s.color, len: Math.max(0, (s.value / total) * c - gap), offset };
  });
  return (
    <div className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--elevated)" strokeWidth={stroke} />
        {total ? arcs.map((a, i) => <circle key={i} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={a.color} strokeWidth={stroke} strokeDasharray={`${a.len} ${c}`} strokeDashoffset={-a.offset} />) : null}
      </svg>
      {center ? (
        <span className="absolute inset-0 flex flex-col items-center justify-center text-center" aria-hidden>
          {center}
        </span>
      ) : null}
    </div>
  );
}

/** Horizontal bar for a 0–100 score with the number beside it. */
export function HealthBar({ score, className }: { score: number; className?: string }) {
  return (
    <span className={cx("flex items-center gap-2.5", className)} title={`Health score ${score} of 100`}>
      <span className="w-7 font-semibold tabular text-fg">{score}</span>
      <span className="h-1.5 w-16 overflow-hidden rounded-full bg-elevated" aria-hidden>
        <span className="block h-full rounded-full" style={{ width: `${score}%`, background: scoreColor(score) }} />
      </span>
    </span>
  );
}

/** Determinate progress bar. */
export function ProgressBar({ value, label, className }: { value: number; label: string; className?: string }) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <div className={cx("h-2.5 overflow-hidden rounded-full bg-elevated", className)} role="progressbar" aria-label={label} aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${v}%` }} />
    </div>
  );
}

// ---------- forms ----------

const control =
  "rounded-[10px] border border-line bg-surface px-3 text-sm shadow-[0_1px_2px_rgb(16_24_40/0.04)] text-fg placeholder:text-fg-3 transition-colors hover:border-line-strong focus:border-accent-ink focus:outline-none focus-visible:outline-none focus:ring-2 focus:ring-accent/20 disabled:opacity-60 aria-[invalid=true]:border-sev-high";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(control, "h-10 w-full", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(control, "min-h-24 w-full py-2 leading-relaxed", className)} {...rest} />;
});

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(control, /(^|\s)w-/.test(className ?? "") ? "" : "w-full", "h-10 cursor-pointer appearance-none bg-[length:16px] bg-[right_8px_center] bg-no-repeat pr-8", className)} style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%235b6779' stroke-width='2'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E")` }} {...rest}>
      {children}
    </select>
  );
}

export function Field({ label, hint, error, children, htmlFor, className }: { label: ReactNode; hint?: ReactNode; error?: string | null; children: ReactNode; htmlFor?: string; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-[13px] font-medium text-fg">
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-sev-high" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-fg-3">{hint}</p>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, hint, checked, onChange, disabled, id }: { label: ReactNode; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; id?: string }) {
  return (
    <label className={cx("flex cursor-pointer items-start gap-2.5", disabled && "cursor-not-allowed opacity-60")}>
      <input id={id} type="checkbox" className="mt-0.5 size-4 shrink-0 cursor-pointer accent-[var(--accent)]" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span className="min-w-0">
        <span className="block text-sm text-fg">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-fg-3">{hint}</span> : null}
      </span>
    </label>
  );
}

/** Segmented control for a small set of exclusive options. */
export function Segmented<T extends string>({ value, onChange, options, label }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[]; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex max-w-full overflow-x-auto rounded-[10px] border border-line bg-elevated p-1">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cx("h-8 shrink-0 whitespace-nowrap rounded-lg px-3 text-[13px] font-medium transition-colors", value === o.value ? "bg-surface text-fg shadow-[0_1px_3px_rgb(16_24_40/0.1)]" : "text-fg-2 hover:text-fg")}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------- text ----------

/** An external URL, rendered as a link only if it is http(s). Opens in a new tab without referrer. */
export function ExternalUrl({ url, children, className }: { url: string; children?: ReactNode; className?: string }) {
  let safe = false;
  try {
    safe = ["http:", "https:"].includes(new URL(url).protocol);
  } catch {
    /* not a URL */
  }
  if (!safe) return <span className={cx("font-mono", className)}>{children ?? url}</span>;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer nofollow" className={cx("group inline-flex min-w-0 items-center gap-1 hover:text-accent-ink", className)}>
      <span className="truncate">{children ?? url}</span>
      <ArrowUpRight className="size-3.5 shrink-0 opacity-50 group-hover:opacity-100" aria-label="(opens in a new tab)" />
    </a>
  );
}

export const Mono = ({ children, className }: { children: ReactNode; className?: string }) => <span className={cx("font-mono text-[12.5px]", className)}>{children}</span>;

/** Label/value rows for metadata. */
export function DefList({ items, className }: { items: { label: ReactNode; value: ReactNode }[]; className?: string }) {
  return (
    <dl className={cx("grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[minmax(120px,max-content)_1fr]", className)}>
      {items.map((it, i) => (
        <div key={i} className="contents">
          <dt className="text-[13px] text-fg-3 sm:pt-px">{it.label}</dt>
          <dd className="-mt-2 min-w-0 text-fg sm:mt-0">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
