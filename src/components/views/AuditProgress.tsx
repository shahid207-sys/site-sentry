"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import {
  ArrowRight,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleSlash,
  FileSearch,
  ListTodo,
  LoaderCircle,
  Pause,
  Play,
  Square,
} from "lucide-react";
import { failureText } from "@/lib/audit/failure";
import type { AuditPhase } from "@/lib/model";
import { api, useApi } from "../lib/api";
import { fmtDuration, plural } from "../lib/format";
import { useToast } from "../overlays";
import { useWs } from "../shell/context";
import {
  AuditStatusBadge,
  Button,
  ErrorState,
  LinkButton,
  Notice,
  PageHeader,
  PageSkeleton,
  Panel,
  ProgressBar,
  StatStrip,
  cx,
} from "../ui";
import type { AuditDetail, AuditSummary } from "@/lib/views";

// One row per real engine phase (lib/crawl/engine.ts), in the order the engine runs them.
const STAGES: { phase: Exclude<AuditPhase, "done">; label: string; desc: string }[] = [
  { phase: "robots", label: "Read robots.txt", desc: "Fetch the site's robots.txt so disallowed URLs are never crawled." },
  { phase: "sitemap", label: "Read the XML sitemap", desc: "Collect page URLs from the sitemap when the audit scope uses it." },
  { phase: "pages", label: "Fetch and check pages", desc: "Fetch each page within the page and depth limits and run the selected checks." },
  { phase: "links", label: "Check link targets", desc: "Request the status of internal links and images that were not crawled." },
  { phase: "finalize", label: "Group and save findings", desc: "Fingerprint findings, compare with the previous audit and save the results." },
];
const ORDER: AuditPhase[] = ["robots", "sitemap", "pages", "links", "finalize", "done"];

type StageState = "done" | "current" | "queued" | "skipped" | "off" | "not_reached";
const STATE_LABEL: Record<StageState, string> = {
  done: "Done",
  current: "Running…",
  queued: "Queued",
  skipped: "Not needed",
  off: "Off for this audit",
  not_reached: "Not reached",
};

function stageStates(d: AuditDetail): StageState[] {
  const a = d.audit;
  const running = a.status === "running";
  const ok = a.status === "completed" || a.status === "partial";
  const cur = ORDER.indexOf(a.phase);
  return STAGES.map((s, i) => {
    // Crawler v2 (Phase 1) crawls only: link checks and findings come with the Phase 2 rule engine.
    if (a.crawler && (s.phase === "links" || s.phase === "finalize")) return "off";
    if (a.crawler && !running) return a.progress.done > 0 || s.phase !== "pages" ? "done" : "not_reached";
    if (a.crawler && i < cur) return "done";
    if (s.phase === "links" && !a.config.checkLinks) return "off";
    if (running) {
      if (i < cur) return s.phase === "sitemap" && !d.sitemap ? "skipped" : "done";
      return i === cur ? "current" : "queued";
    }
    switch (s.phase) {
      case "robots":
        return d.robots ? "done" : "not_reached";
      case "sitemap":
        return d.sitemap ? "done" : ok ? "skipped" : "not_reached";
      case "pages":
        return a.progress.done > 0 ? "done" : "not_reached";
      case "links":
        return a.progress.linksChecked > 0 || ok ? "done" : "not_reached";
      case "finalize":
        return a.findingCounts ? "done" : "not_reached";
    }
  });
}

// Order and wording for crawler v2 URL states (docs/CRAWLER-STATES.md).
const URL_STATE_LABELS: [string, string][] = [
  ["discovered", "Waiting"],
  ["queued", "Claimed by the worker"],
  ["fetching", "Being fetched"],
  ["fetched", "Fetched"],
  ["redirected", "Redirected"],
  ["non_html", "Not HTML"],
  ["oversized", "Over the size cap"],
  ["blocked_robots", "Blocked by robots.txt"],
  ["out_of_scope", "Out of scope"],
  ["excluded_by_rule", "Excluded by a rule"],
  ["depth_exceeded", "Beyond the depth limit"],
  ["budget_exhausted", "Over the page budget"],
  ["failed_timeout", "Timed out"],
  ["failed_dns", "DNS failure"],
  ["failed_tls", "TLS failure"],
  ["failed_network", "Network error"],
  ["interrupted", "Interrupted (not re-requested)"],
  ["cancelled", "Cancelled"],
];

function UrlStates({ states }: { states: Record<string, number> }) {
  const rows = URL_STATE_LABELS.filter(([k]) => states[k]);
  return (
    <Panel title="URL states" description="Every discovered URL is in exactly one state; finished URLs keep the reason they ended there." flush>
      {rows.length ? (
        <dl className="grid grid-cols-1 divide-y divide-line-subtle sm:grid-cols-2 sm:divide-y-0">
          {rows.map(([k, label]) => (
            <div key={k} className="flex items-baseline justify-between gap-3 px-5 py-2.5">
              <dt className="text-[13px] text-fg-2">{label}</dt>
              <dd className="tabular text-sm font-semibold text-fg">{states[k]}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="px-5 py-4 text-[13px] text-fg-3">No URLs yet: the worker has not started this crawl.</p>
      )}
    </Panel>
  );
}

function Outcome({ audit, href }: { audit: AuditSummary; href: string }) {
  const open = (
    <LinkButton href={href} variant="primary" size="sm" icon={ArrowRight}>
      Open results
    </LinkButton>
  );
  if (audit.status === "completed_empty")
    return (
      <Notice tone="warn" title="Crawl complete: nothing to analyse" action={open}>
        {audit.emptyReason ?? "No HTML page was fetched, so no checks ran."} This is not a clean result.
      </Notice>
    );
  if (audit.crawler && audit.status === "completed")
    return (
      <Notice tone="warn" title="Crawl complete: no checks were run" action={open}>
        Crawler v2 records which URLs were found and fetched. SEO checks are not run on it yet, so this audit has no findings; that is not a clean result.
      </Notice>
    );
  if (audit.status === "completed")
    return (
      <Notice tone="ok" title="Audit complete" action={open}>
        Every planned page was fetched and checked.
      </Notice>
    );
  if (audit.status === "partial")
    return (
      <Notice tone="warn" title="Audit finished with partial coverage" action={open}>
        Some planned pages could not be fetched or were skipped. The results cover what was checked.
      </Notice>
    );
  if (audit.status === "cancelled")
    return (
      <Notice tone="info" title="Audit cancelled" action={open}>
        Results collected before the cancellation were kept.
      </Notice>
    );
  return (
    <Notice tone="error" title="Audit failed" action={open}>
      {(() => {
        const { label, message } = failureText(audit.error, "The audit stopped before it could finish.");
        return label ? `${label}: ${message}` : message;
      })()}
    </Notice>
  );
}

export function AuditProgressView() {
  const { auditId } = useParams<{ auditId: string }>();
  const { base, apiBase } = useWs();
  const toast = useToast();

  const { data: initialAudit, error: loadError, reload } = useApi<AuditDetail>(`${apiBase}/audits/${auditId}`);
  const [audit, setAudit] = useState<AuditDetail | null>(null);
  const [stepError, setStepError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [toggling, setToggling] = useState(false);
  const alive = useRef(true);

  // Step loop
  useEffect(() => {
    if (!initialAudit || initialAudit.audit.status !== "running") return;

    alive.current = true;
    let timeoutId: ReturnType<typeof setTimeout>;
    let consecutiveErrors = 0;

    const tick = async () => {
      if (!alive.current) return;
      if (document.hidden) {
        timeoutId = setTimeout(tick, 1500);
        return;
      }

      try {
        const res = await api<{ audit: AuditSummary; busy: boolean }>(`${apiBase}/audits/${auditId}/step`, {
          method: "POST",
        });

        if (!alive.current) return;
        consecutiveErrors = 0;
        setStepError(null);

        // Fetch fresh detail to show findings count and progress
        const updated = await api<AuditDetail>(`${apiBase}/audits/${auditId}`);
        if (!alive.current) return;
        setAudit(updated);

        if (res.audit.status !== "running") {
          toast({ tone: "ok", title: "Audit finished", detail: `${plural(res.audit.progress.inspected, "page")} inspected.` });
          return;
        }

        timeoutId = setTimeout(tick, res.busy ? 1400 : 200);
      } catch (err) {
        consecutiveErrors++;
        setStepError((err as Error).message);
        if (consecutiveErrors < 6) {
          timeoutId = setTimeout(tick, 2000 * consecutiveErrors);
        }
      }
    };

    void tick();

    return () => {
      alive.current = false;
      clearTimeout(timeoutId);
    };
  }, [apiBase, auditId, initialAudit, toast]);

  const cancelAudit = async () => {
    setCancelling(true);
    try {
      await api(`${apiBase}/audits/${auditId}/cancel`, { method: "POST" });
      toast({ tone: "info", title: "Audit cancelled", detail: "Results collected so far were preserved as partial." });
      const updated = await api<AuditDetail>(`${apiBase}/audits/${auditId}`);
      setAudit(updated);
    } catch (e) {
      toast({ tone: "error", title: "Could not cancel", detail: (e as Error).message });
    } finally {
      setCancelling(false);
    }
  };

  const togglePause = async (action: "pause" | "resume") => {
    setToggling(true);
    try {
      await api(`${apiBase}/audits/${auditId}/${action}`, { method: "POST" });
      setAudit(await api<AuditDetail>(`${apiBase}/audits/${auditId}`));
    } catch (e) {
      toast({ tone: "error", title: action === "pause" ? "Could not pause" : "Could not resume", detail: (e as Error).message });
    } finally {
      setToggling(false);
    }
  };

  const currentAudit = audit || initialAudit;
  const crumbs = [
    { label: "Audits", href: `${base}/audits` },
    ...(currentAudit ? [{ label: currentAudit.site.name, href: `${base}/audits?site=${currentAudit.site.id}` }] : []),
    { label: "Progress" },
  ];

  if (loadError) return <ErrorState error={loadError} onRetry={reload} />;
  if (!currentAudit) return <PageSkeleton />;

  const a = currentAudit.audit;
  const p = a.progress;
  const isRunning = a.status === "running";
  // No made-up percentage: until the engine knows how many pages are planned, the bar waits.
  const pct = a.status === "completed" ? 100 : p.planned ? Math.min(100, Math.round((p.done / p.planned) * 100)) : isRunning ? null : 0;
  const states = stageStates(currentAudit);
  const resultsHref = `${base}/audits/${auditId}`;

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={crumbs}
        title={isRunning ? `Auditing ${currentAudit.site.name}` : `Audit of ${currentAudit.site.name}`}
        description={<span className="font-mono text-[13px]">{currentAudit.site.origin}</span>}
        meta={
          <div className="flex items-center gap-2">
            <AuditStatusBadge status={a.status} stale={a.stale} />
            <span className="text-[13px] text-fg-3">
              {isRunning ? "Running for" : "Took"} {fmtDuration(a.startedAt, a.finishedAt ?? new Date().toISOString())}
            </span>
          </div>
        }
        actions={
          <div className="flex items-center gap-2">
            <LinkButton href={`${base}/audits`} variant="ghost">
              All audits
            </LinkButton>
            {isRunning && a.crawler ? (
              a.crawler.status === "paused" ? (
                <Button icon={Play} loading={toggling} onClick={() => togglePause("resume")}>
                  Resume
                </Button>
              ) : (
                <Button icon={Pause} loading={toggling} disabled={a.crawler.status === "cancelling"} onClick={() => togglePause("pause")}>
                  Pause
                </Button>
              )
            ) : null}
            {isRunning ? (
              <Button variant="danger" icon={Square} loading={cancelling} onClick={cancelAudit}>
                Cancel audit
              </Button>
            ) : (
              <LinkButton href={resultsHref} variant="primary" icon={ArrowRight}>
                View results
              </LinkButton>
            )}
          </div>
        }
      />

      <Panel>
        <div className="space-y-4">
          <div className="flex items-baseline justify-between gap-3">
            <p className="flex items-center gap-2 text-base font-semibold text-fg">
              {isRunning ? <LoaderCircle className="size-4 animate-spin text-accent-ink" aria-hidden /> : null}
              {isRunning
                ? a.crawler?.status === "paused"
                  ? "Paused"
                  : a.crawler?.status === "cancelling"
                    ? "Cancelling…"
                    : STAGES.find((s) => s.phase === a.phase)?.label ?? "Working…"
                : "Finished"}
            </p>
            <p className="text-sm text-fg-2">
              {p.planned ? `${p.done} of ${plural(p.planned, "page")}` : "Planning pages…"}
              {pct !== null ? <span className="ml-2 text-lg font-semibold tabular text-fg">{pct}%</span> : null}
            </p>
          </div>
          {pct !== null ? (
            <ProgressBar value={pct} label="Audit progress" className="h-2.5" />
          ) : (
            <div className="h-2.5 w-full overflow-hidden rounded-full bg-elevated" role="progressbar" aria-label="Audit progress">
              <div className="h-full w-1/3 animate-pulse rounded-full bg-accent/60" />
            </div>
          )}
          {stepError ? (
            <Notice tone="warn" title="A crawl step failed; retrying">
              {stepError}
            </Notice>
          ) : null}
          {!isRunning ? <Outcome audit={a} href={resultsHref} /> : null}
        </div>
      </Panel>

      <StatStrip
        items={[
          { label: "Pages inspected", value: p.inspected, hint: p.planned ? `${p.done} of ${p.planned} processed` : "None yet", icon: FileSearch, tone: "accent" },
          { label: "Pages remaining", value: isRunning ? Math.max(0, p.planned - p.done) : 0, hint: isRunning ? "Still queued" : "Crawl finished", icon: ListTodo, tone: "info" },
          { label: "Findings", value: currentAudit.findings?.length ?? 0, hint: isRunning ? "Recorded so far" : "In this audit", icon: CircleAlert, tone: "high" },
          { label: "Failed or skipped", value: p.failed + p.skipped, hint: `${p.failed} failed · ${p.skipped} skipped`, icon: CircleSlash, tone: "medium" },
        ]}
      />

      {a.crawler?.startRedirect ? (
        <Notice tone="info" title={`Started at ${a.crawler.startRedirect.from}, redirected to ${a.crawler.startRedirect.to}`}>
          The start URL redirects to another address of the same site, so the crawl covers {new URL(a.crawler.startRedirect.to).host} and reads its robots.txt.
        </Notice>
      ) : null}
      {a.crawler ? <UrlStates states={a.crawler.states} /> : null}
      {a.crawler?.blobMissing ? (
        <Notice tone="warn" title={`Raw HTML missing for ${plural(a.crawler.blobMissing, "page")}`}>
          These pages were fetched and checked, but their HTML could not be saved to storage after a retry (blob_missing), so it cannot be viewed or re-analysed later.
        </Notice>
      ) : null}

      <Panel title="Audit steps" description="What the crawler does, in order. Steps outside this audit's scope are marked." flush>
        <ol className="divide-y divide-line-subtle">
          {STAGES.map((stage, idx) => {
            const st = states[idx];
            return (
              <li key={stage.phase} className={cx("flex items-start gap-4 px-5 py-4", st === "current" && "bg-sidebar-active")}>
                <span
                  className={cx(
                    "mt-0.5 grid size-8 shrink-0 place-items-center rounded-full",
                    st === "done" && "bg-ok-soft text-ok",
                    st === "current" && "bg-accent-soft text-accent-ink",
                    (st === "queued" || st === "not_reached") && "border border-line bg-elevated text-xs font-semibold text-fg-3",
                    (st === "skipped" || st === "off") && "bg-elevated text-fg-3",
                  )}
                  aria-hidden
                >
                  {st === "done" ? (
                    <CircleCheck className="size-4.5" />
                  ) : st === "current" ? (
                    <LoaderCircle className="size-4.5 animate-spin" />
                  ) : st === "skipped" || st === "off" ? (
                    <CircleMinus className="size-4.5" />
                  ) : (
                    idx + 1
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <p className={cx("text-sm font-semibold", st === "current" ? "text-accent-ink" : st === "done" ? "text-fg" : "text-fg-2")}>{stage.label}</p>
                    <span
                      className={cx(
                        "text-xs font-medium",
                        st === "done" ? "text-ok" : st === "current" ? "text-accent-ink" : st === "not_reached" ? "text-sev-high" : "text-fg-3",
                      )}
                    >
                      {STATE_LABEL[st]}
                    </span>
                  </div>
                  <p className="mt-0.5 text-[13px] text-fg-2">{stage.desc}</p>
                </div>
              </li>
            );
          })}
        </ol>
      </Panel>
    </div>
  );
}
