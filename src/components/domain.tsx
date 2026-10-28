"use client";
// Domain components shared by several pages.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CircleAlert, CircleCheck, CircleDashed, CircleX, Copy, ScanSearch, TriangleAlert } from "lucide-react";
import { useState, type FormEvent } from "react";
import { RULE_CATEGORIES, type AuditFinding, type CriterionResult, type Severity } from "@/lib/audit/types";
import { describeLimits, PROFILES } from "@/lib/crawl/profiles";
import type { Site } from "@/lib/model";
import { SEVERITIES, type AuditSummary, type SeverityCounts } from "@/lib/views";
import { api, ApiError } from "./lib/api";
import { fmtAgo, fmtDateTime, plural, shortUrl } from "./lib/format";
import { useCopy, useToast } from "./overlays";
import { useWs } from "./shell/context";
import { AuditStatusBadge, Button, cx, Field, Input, Mono, Segmented, Textarea } from "./ui";

const SEV_ICON = { high: CircleAlert, medium: TriangleAlert, low: CircleDashed } as const;
const SEV_TEXT = { high: "text-sev-high", medium: "text-sev-medium", low: "text-sev-low" } as const;
export const SEV_LABEL: Record<Severity, string> = { high: "High", medium: "Medium", low: "Low" };

/** "3 high · 5 medium · 1 low" with icons; zeroes are dimmed rather than hidden so columns align. */
export function SeverityCountsInline({ counts, compact }: { counts: SeverityCounts; compact?: boolean }) {
  const total = counts.high + counts.medium + counts.low;
  if (total === 0) return <span className="text-[13px] text-fg-3">None open</span>;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[13px] tabular">
      {SEVERITIES.map((s) => {
        const Icon = SEV_ICON[s];
        const n = counts[s];
        return (
          <span key={s} className={cx("inline-flex items-center gap-1", n ? SEV_TEXT[s] : "text-fg-3/60")} title={`${n} ${s} severity`}>
            <Icon className="size-3.5" aria-hidden />
            {n}
            <span className={compact ? "sr-only" : "text-fg-3"}> {s}</span>
          </span>
        );
      })}
    </span>
  );
}

/** Proportional bar of open issues by severity, with the numbers printed beside it. */
export function SeverityBar({ counts }: { counts: SeverityCounts }) {
  const total = counts.high + counts.medium + counts.low;
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-elevated" role="img" aria-label={`${counts.high} high, ${counts.medium} medium, ${counts.low} low`}>
        {total
          ? SEVERITIES.map((s) =>
              counts[s] ? <span key={s} className={cx("h-full", s === "high" ? "bg-sev-high" : s === "medium" ? "bg-sev-medium" : "bg-sev-low")} style={{ width: `${(counts[s] / total) * 100}%` }} /> : null,
            )
          : null}
      </div>
      <ul className="mt-3 grid grid-cols-3 gap-2">
        {SEVERITIES.map((s) => {
          const Icon = SEV_ICON[s];
          return (
            <li key={s}>
              <span className={cx("flex items-center gap-1.5 text-xs", SEV_TEXT[s])}>
                <Icon className="size-3.5" aria-hidden />
                {SEV_LABEL[s]}
              </span>
              <span className="mt-0.5 block text-lg font-semibold text-fg tabular">{counts[s]}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

type AddMethod = "single" | "sitemap" | "list";
const ADD_METHODS: { value: AddMethod; label: string }[] = [
  { value: "single", label: "Single URL" },
  { value: "sitemap", label: "XML sitemap" },
  { value: "list", label: "URL list" },
];
/** First audits run the Quick profile so they finish quickly; New audit offers every profile. */
const FIRST_AUDIT = PROFILES.quick;
const FIRST_AUDIT_LIMITS = describeLimits(FIRST_AUDIT.budget, FIRST_AUDIT.maxDepth);

/**
 * Adds a site and, optionally, starts its first audit straight away. "Add site" only stores the
 * site; "Start audit" also queues a bounded audit and opens its progress page.
 */
export function AddSiteForm({ onCreated, autoFocus }: { onCreated?: (s: Site) => void; autoFocus?: boolean }) {
  const { apiBase, base, sites } = useWs();
  const router = useRouter();
  const toast = useToast();
  const [name, setName] = useState("");
  const [origin, setOrigin] = useState("");
  const [method, setMethod] = useState<AddMethod>("single");
  const [sitemapUrl, setSitemapUrl] = useState("");
  const [urlList, setUrlList] = useState("");
  const [busy, setBusy] = useState<"add" | "audit" | null>(null);
  const [error, setError] = useState<{ field: "name" | "origin" | "urls" | null; message: string; siteId?: string } | null>(null);

  const submit = async (e: FormEvent, withAudit: boolean) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError({ field: "name", message: "Give the site a name." });
    if (!origin.trim()) return setError({ field: "origin", message: "Enter the site's address, e.g. https://www.example.com" });
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(origin.trim()) ? origin.trim() : `https://${origin.trim()}`;
    const abs = (u: string) => {
      try {
        return new URL(u.trim(), url).href;
      } catch {
        return u.trim();
      }
    };
    const listUrls = urlList.split(/\s+/).filter(Boolean).map(abs);
    if (withAudit && method === "list" && listUrls.length === 0) return setError({ field: "urls", message: "Enter at least one URL, one per line." });
    setBusy(withAudit ? "audit" : "add");
    let site: Site | null = null;
    try {
      site = await api<Site>(`${apiBase}/sites`, { method: "POST", body: { name: name.trim(), origin: url } });
    } catch (err) {
      const e2 = err as ApiError;
      const existing = e2.code === "CONFLICT" ? (e2.details?.siteId as string | undefined) : undefined;
      if (!(withAudit && existing)) {
        setBusy(null);
        return setError({ field: e2.code === "CONFLICT" ? "origin" : /name/i.test(e2.message) ? "name" : "origin", message: e2.message, siteId: existing });
      }
      // Already set up: audit the existing site rather than failing.
      site = { id: existing } as Site;
    }
    await sites.reload();
    if (!withAudit) {
      toast({ tone: "ok", title: `${site.name} added`, detail: "Add its important URLs, then run the first audit." });
      setName("");
      setOrigin("");
      setBusy(null);
      if (onCreated) onCreated(site);
      else router.push(`${base}/sites/${site.id}`);
      return;
    }
    try {
      const r = await api<{ audit: AuditSummary; reused: boolean }>(`${apiBase}/audits`, {
        method: "POST",
        body: {
          siteId: site.id,
          mode: method,
          urls: method === "single" ? [url] : method === "list" ? listUrls : [],
          sitemapUrl: method === "sitemap" && sitemapUrl.trim() ? abs(sitemapUrl) : undefined,
          profile: FIRST_AUDIT.id,
          categories: RULE_CATEGORIES.map((c) => c.id),
          checkLinks: false,
          includeImportant: false,
        },
      });
      router.push(`${base}/audits/${r.audit.id}/progress`);
    } catch (err) {
      setBusy(null);
      setError({ field: method === "list" ? "urls" : null, message: `The site was saved, but the audit didn't start: ${(err as ApiError).message}`, siteId: site.id });
    }
  };

  return (
    <form onSubmit={(e) => submit(e, false)} noValidate className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="site-name" error={error?.field === "name" ? error.message : null}>
          <Input id="site-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Outdoor" autoFocus={autoFocus} aria-invalid={error?.field === "name"} maxLength={100} />
        </Field>
        <Field label="Address" htmlFor="site-origin" error={error?.field === "origin" ? error.message : null} hint="A public http(s) address. Private and local addresses are refused.">
          <Input id="site-origin" value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://www.example.com" inputMode="url" autoComplete="url" aria-invalid={error?.field === "origin"} />
        </Field>
      </div>

      <div className="rounded-xl border border-line-subtle bg-surface-secondary p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-[13px] font-medium text-fg">First audit</p>
          <Segmented label="First audit scope" value={method} onChange={setMethod} options={ADD_METHODS} />
        </div>
        {method === "single" ? (
          <p className="mt-3 text-[13px] text-fg-3">
            {FIRST_AUDIT.label} audit from the address above: {FIRST_AUDIT_LIMITS}.
          </p>
        ) : method === "sitemap" ? (
          <Field className="mt-3" label="Sitemap URL" htmlFor="site-sitemap" hint={`Leave empty to use the robots.txt declaration, else /sitemap.xml. ${FIRST_AUDIT.label} audit: ${FIRST_AUDIT_LIMITS}.`}>
            <Input id="site-sitemap" value={sitemapUrl} onChange={(e) => setSitemapUrl(e.target.value)} placeholder="/sitemap.xml" inputMode="url" />
          </Field>
        ) : (
          <Field className="mt-3" label="URLs to audit" htmlFor="site-urls" error={error?.field === "urls" ? error.message : null} hint={`One per line. Paths like /pricing are resolved against the address. ${FIRST_AUDIT.label} audit: ${FIRST_AUDIT_LIMITS}.`}>
            <Textarea id="site-urls" rows={3} value={urlList} onChange={(e) => setUrlList(e.target.value)} placeholder={"/\n/pricing\n/contact"} aria-invalid={error?.field === "urls"} />
          </Field>
        )}
      </div>

      {error && error.field === null ? (
        <p role="alert" className="rounded-lg border border-sev-high/25 bg-sev-high-soft px-3 py-2 text-[13px] text-sev-high">
          {error.message}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-end gap-2.5">
        {error?.siteId ? (
          <Link className="mr-auto text-[13px] font-medium text-accent-ink hover:underline" href={`${base}/sites/${error.siteId}`}>
            Open the existing site
          </Link>
        ) : null}
        <Button type="submit" loading={busy === "add"} disabled={busy !== null}>
          Add site
        </Button>
        <Button type="button" variant="primary" icon={ScanSearch} loading={busy === "audit"} disabled={busy !== null} onClick={(e) => submit(e, true)}>
          Start audit
        </Button>
      </div>
    </form>
  );
}

/** One audit run: status and time on the first line, scope and findings on the second (fits narrow columns). */
export function AuditLine({ a, showSite = true }: { a: AuditSummary; showSite?: boolean }) {
  const { base } = useWs();
  return (
    <Link href={`${base}/audits/${a.id}`} className="block px-4 py-3 transition-colors hover:bg-elevated/60">
      <span className="flex items-center gap-2">
        <AuditStatusBadge status={a.status} stale={a.stale} />
        {showSite ? <span className="min-w-0 truncate text-sm font-medium text-fg">{a.siteName}</span> : null}
        <span className="ml-auto shrink-0 text-[13px] text-fg-3" title={fmtDateTime(a.startedAt)}>
          {fmtAgo(a.startedAt)}
        </span>
      </span>
      <span className="mt-1.5 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
        <span className="text-[13px] text-fg-2">
          {a.config.mode === "single" ? "Single URL" : a.config.mode === "list" ? "URL list" : "Sitemap"} · {plural(a.progress.inspected, "page")}
          {a.progress.failed ? <span className="text-sev-medium"> · {a.progress.failed} failed</span> : null}
        </span>
        {a.findingCounts ? <SeverityCountsInline counts={a.findingCounts} compact /> : null}
      </span>
    </Link>
  );
}

// ---------- evidence ----------

export function Snippets({ snippets }: { snippets: string[] }) {
  const copy = useCopy();
  if (!snippets.length) return null;
  return (
    <div className="flex flex-col gap-2">
      {snippets.map((s, i) => (
        <div key={i} className="group relative rounded-md border border-line-subtle bg-bg">
          {/* Fetched page content: always rendered as text, never as HTML. */}
          <pre className="evidence max-h-64 overflow-y-auto p-3 pr-10 font-mono text-[12.5px] leading-relaxed text-fg-2">{s}</pre>
          <button type="button" onClick={() => copy(s, "Snippet copied")} className="absolute right-2 top-2 rounded p-1 text-fg-3 opacity-70 hover:bg-hover hover:text-fg group-hover:opacity-100" aria-label="Copy snippet">
            <Copy className="size-3.5" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function FactsTable({ facts }: { facts: Record<string, string | number | boolean | null> }) {
  const entries = Object.entries(facts);
  if (!entries.length) return null;
  return (
    <div className="overflow-hidden rounded-md border border-line-subtle">
      <table className="w-full table-fixed text-[13px]">
        <tbody>
          {entries.map(([k, v]) => (
            <tr key={k} className="border-b border-line-subtle last:border-0">
              <th scope="row" className="w-2/5 bg-bg/50 px-3 py-1.5 text-left align-top font-normal">
                <Mono className="evidence text-fg-3">{k}</Mono>
              </th>
              <td className="px-3 py-1.5 align-top">
                <Mono className={cx("evidence", v === null ? "text-fg-3" : "text-fg")}>{v === null ? "null" : String(v)}</Mono>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CriteriaList({ criteria, results }: { criteria: AuditFinding["acceptanceCriteria"]; results?: CriterionResult[] }) {
  return (
    <ul className="flex flex-col gap-2">
      {criteria.map((c) => {
        const r = results?.find((x) => x.id === c.id);
        const Icon = !r ? CircleDashed : r.passed ? CircleCheck : CircleX;
        return (
          <li key={c.id} className="flex items-start gap-2.5 text-sm">
            <Icon className={cx("mt-0.5 size-4 shrink-0", !r ? "text-fg-3" : r.passed ? "text-ok" : "text-sev-high")} aria-label={!r ? "Not yet checked" : r.passed ? "Passed" : "Failed"} />
            <span className="min-w-0">
              <span className="text-fg">{c.description}</span>
              {r ? (
                <span className="mt-0.5 block text-[13px] text-fg-3">
                  Saw: <Mono className="evidence text-fg-2">{r.actual}</Mono>
                </span>
              ) : null}
              {Object.keys(c.params).length ? (
                <span className="mt-0.5 block break-all text-xs text-fg-3">
                  <Mono>
                    {c.id}({Object.entries(c.params).map(([k, v]) => `${k}=${v}`).join(", ")})
                  </Mono>
                </span>
              ) : null}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** Observation / Diagnosis / Recommendation, kept visibly separate. */
export function FindingExplanation({ f }: { f: AuditFinding }) {
  return (
    <div className="grid gap-px overflow-hidden rounded-lg border border-line-subtle bg-line-subtle">
      <div className="bg-surface p-4">
        <p className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-3">Observation · measured</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-xs text-fg-3">Observed</p>
            <p className="evidence mt-0.5 text-sm text-fg">{f.observed}</p>
          </div>
          <div>
            <p className="text-xs text-fg-3">Expected</p>
            <p className="evidence mt-0.5 text-sm text-fg">{f.expected}</p>
          </div>
        </div>
      </div>
      <div className="bg-surface p-4">
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-fg-3">Why it merits review</p>
        <p className="text-sm text-fg-2">{f.why}</p>
      </div>
      {f.diagnosis ? (
        <div className="bg-surface p-4">
          <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-fg-3">Diagnosis · likely, not proven</p>
          <p className="text-sm text-fg-2">{f.diagnosis}</p>
        </div>
      ) : null}
      <div className="bg-surface p-4">
        <p className="mb-1.5 text-xs font-medium uppercase tracking-wider text-fg-3">Recommendation · needs judgment</p>
        <ul className="list-disc space-y-1 pl-5 text-sm text-fg-2 marker:text-fg-3">
          {f.recommendations.map((r, i) => (
            <li key={i}>{r}</li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function AffectedUrls({ f }: { f: AuditFinding }) {
  const urls = f.evidence.urls ?? [];
  if (!urls.length) return null;
  return (
    <ul className="divide-y divide-line-subtle overflow-hidden rounded-md border border-line-subtle">
      {urls.map((u) => (
        <li key={u.url + u.detail} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3">
          <Mono className="evidence min-w-0 flex-1 text-fg">{shortUrl(u.url)}</Mono>
          <span className="text-[13px] text-fg-3">{u.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/** Developer-ready brief: Markdown the user can paste into a ticket. Built only from stored evidence. */
export function taskBrief(f: AuditFinding, extra?: { notes?: string; owner?: string | null; sample?: boolean }) {
  const lines = [
    `## ${f.title}`,
    extra?.sample ? "\n> SAMPLE DATA: generated from SiteSentry's fictional sample workspace.\n" : "",
    `**Rule:** \`${f.ruleCode}\` · **Severity:** ${f.priority.severity} (P${f.priority.level}) · **Certainty:** ${f.certainty.replace("_", " ")}`,
    `**Affected URL:** ${f.pageUrl}`,
    ...(f.evidence.urls?.length ? ["", "**Affected URLs:**", ...f.evidence.urls.map((u) => `- ${u.url} (${u.detail})`)] : []),
    "",
    "### Problem",
    f.message || f.why,
    "",
    "### Observed",
    "```",
    f.observed,
    "```",
    ...(f.evidence.snippets.length ? ["", "### Evidence", "```html", ...f.evidence.snippets, "```"] : []),
    "",
    "### Expected",
    f.expected,
    "",
    "### Recommended remediation",
    ...f.recommendations.map((r) => `- ${r}`),
    "",
    "### Acceptance criteria",
    ...f.acceptanceCriteria.map((c) => `- [ ] ${c.description}`),
    "",
    "### Regression checks after deploying",
    `- Re-run the SiteSentry verification for this task (re-checks \`${f.ruleCode}\` against the criteria above).`,
    "- Run a new audit of the site and confirm no new findings appear on the affected URL(s).",
    ...(extra?.notes ? ["", "### Notes", extra.notes] : []),
  ];
  return lines.filter((l, i) => l !== "" || lines[i - 1] !== "").join("\n");
}
