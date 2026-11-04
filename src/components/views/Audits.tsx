"use client";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Globe, Play, ScanSearch, Trash2 } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";
import { RULE_CATEGORIES, type RuleCategory } from "@/lib/audit/types";
import { describeLimits, LEGACY_ENGINE_LIMITS, MAX_BUDGET, MAX_DEPTH, PROFILE_IDS, PROFILES, RENDER_MODE_LABELS, RESOURCE_BUDGET_DEFAULTS, type ProfileId, type RenderMode } from "@/lib/crawl/profiles";
import type { AuditMode } from "@/lib/model";
import type { AuditSummary, SettingsData } from "@/lib/views";
import { SeverityCountsInline } from "../domain";
import { api, ApiError, useApi } from "../lib/api";
import { cleanHost, fmtAgo, fmtDateTime, fmtDuration, plural, siteOptionLabel } from "../lib/format";
import { ConfirmDialog, useToast } from "../overlays";
import { useWs } from "../shell/context";
import {
  AuditStatusBadge,
  Button,
  Checkbox,
  EmptyState,
  ErrorState,
  Field,
  Input,
  LinkButton,
  Notice,
  PageHeader,
  PageSkeleton,
  Panel,
  Segmented,
  Select,
  Textarea,
} from "../ui";

const MODE_LABEL: Record<AuditMode, string> = { single: "Single URL", list: "URL list", sitemap: "Sitemap" };
const ADD_SITE = "__add_site__";
const SITE_REQUIRED = "Choose a website before starting the audit.";
// Profiles come from the shared config (src/lib/crawl/profiles.ts); the API validates again.
const LIMITS = LEGACY_ENGINE_LIMITS;
const ruleLines = (s: string) => s.split("\n").map((l) => l.trim()).filter(Boolean);

// ---------- delete ----------

const RUNNING_HINT = "Running audits can't be deleted. Cancel it first.";

/** Confirms and deletes one audit. Tasks created from it keep their own copy of the findings. */
export function DeleteAuditDialog({ audit, onClose, onDeleted }: { audit: AuditSummary | null; onClose: () => void; onDeleted: () => void }) {
  const { apiBase, sites } = useWs();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (!audit) return;
    setBusy(true);
    try {
      await api(`${apiBase}/audits/${audit.id}`, { method: "DELETE" });
      toast({ tone: "ok", title: "Audit deleted", detail: `${audit.siteName} · ${fmtDateTime(audit.startedAt)}` });
      void sites.reload();
      onDeleted();
    } catch (e) {
      toast({ tone: "error", title: "Could not delete the audit", detail: (e as Error).message });
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return (
    <ConfirmDialog
      open={!!audit}
      onClose={onClose}
      onConfirm={confirm}
      busy={busy}
      danger
      title="Delete this audit?"
      confirmLabel="Delete audit"
      description={audit ? `${audit.siteName}, started ${fmtDateTime(audit.startedAt)}. Its findings, page snapshots and exports are removed, and comparisons and issue history no longer include it. Fix tasks are kept. This cannot be undone.` : null}
    />
  );
}

/** Confirms and deletes every audit of a site, plus the tasks built from them. The site stays. */
export function ClearAuditHistoryDialog({ site, auditCount, open, onClose, onCleared }: { site: { id: string; name: string }; auditCount: number; open: boolean; onClose: () => void; onCleared: () => void }) {
  const { apiBase, sites } = useWs();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      const r = await api<{ auditsDeleted: number; tasksDeleted: number }>(`${apiBase}/sites/${site.id}/audits`, { method: "DELETE" });
      toast({ tone: "ok", title: `Audit history cleared for ${site.name}`, detail: `${plural(r.auditsDeleted, "audit")} and ${plural(r.tasksDeleted, "task")} deleted. The site and its important URLs are kept.` });
      void sites.reload();
      onCleared();
    } catch (e) {
      toast({ tone: "error", title: "Could not clear the audit history", detail: (e as Error).message });
    } finally {
      setBusy(false);
      onClose();
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      onConfirm={confirm}
      busy={busy}
      danger
      title={`Delete all audits of ${site.name}?`}
      confirmLabel="Delete audit history"
      description={`This removes ${plural(auditCount, "audit")} with their findings and snapshots, the issue history built from them, and every fix task for this site. The site, its important URLs and your settings are kept, so you can start fresh with a new audit. This cannot be undone.`}
    />
  );
}

function DeleteAuditButton({ audit, onClick }: { audit: AuditSummary; onClick: () => void }) {
  const running = audit.status === "running";
  return (
    <button
      type="button"
      className="rounded-md p-2 text-fg-3 hover:bg-hover hover:text-sev-high disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-fg-3"
      aria-label={`Delete audit of ${audit.siteName} from ${fmtDateTime(audit.startedAt)}`}
      title={running ? RUNNING_HINT : "Delete audit"}
      disabled={running}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick();
      }}
    >
      <Trash2 className="size-4" aria-hidden />
    </button>
  );
}

// ---------- list ----------

export function AuditsView() {
  const { base, apiBase, sites } = useWs();
  const sp = useSearchParams();
  const router = useRouter();
  const site = sp.get("site") ?? "";
  const status = sp.get("status") ?? "";
  const { data, error, loading, reload } = useApi<AuditSummary[]>(`${apiBase}/audits${site ? `?site=${site}` : ""}`);
  const [deleting, setDeleting] = useState<AuditSummary | null>(null);
  const [clearing, setClearing] = useState(false);
  const siteRow = (sites.data ?? []).find((s) => s.site.id === site)?.site;
  const rows = useMemo(() => (data ?? []).filter((a) => !status || (status === "stale" ? a.stale : a.status === status && !a.stale)), [data, status]);
  const setParam = (k: string, v: string) => {
    const p = new URLSearchParams(sp.toString());
    if (v) p.set(k, v);
    else p.delete(k);
    router.replace(`${base}/audits${p.size ? `?${p}` : ""}`);
  };

  const header = (
    <PageHeader
      crumbs={[{ label: "Audits" }]}
      title="Audits"
      description="Every audit is an immutable snapshot. Comparisons and issue history are built from these."
      actions={<LinkButton href={`${base}/audits/new`} variant="primary" icon={ScanSearch}>New audit</LinkButton>}
    />
  );
  if (error) return (<>{header}<ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return <PageSkeleton />;

  return (
    <>
      {header}
      {data?.length || site || status ? (
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Select aria-label="Site" value={site} onChange={(e) => setParam("site", e.target.value)} className="h-8 w-auto min-w-40 text-[13px]">
          <option value="">All sites</option>
          {(sites.data ?? []).map((s) => <option key={s.site.id} value={s.site.id}>{s.site.name}</option>)}
        </Select>
        <Select aria-label="Status" value={status} onChange={(e) => setParam("status", e.target.value)} className="h-8 w-auto min-w-36 text-[13px]">
          <option value="">Any status</option>
          <option value="running">Running</option>
          <option value="stale">Interrupted</option>
          <option value="completed">Completed</option>
          <option value="partial">Partial</option>
          <option value="failed">Failed</option>
          <option value="cancelled">Cancelled</option>
        </Select>
        <span className="ml-auto text-[13px] text-fg-3">{plural(rows.length, "audit")}</span>
        {siteRow && data?.length ? (
          <Button size="sm" variant="danger" icon={Trash2} onClick={() => setClearing(true)} disabled={data.some((a) => a.status === "running")} title={data.some((a) => a.status === "running") ? RUNNING_HINT : undefined}>
            Delete all audits of {siteRow.name}
          </Button>
        ) : null}
      </div>
      ) : null}
      <Panel flush>
        {rows.length === 0 ? (
          <EmptyState icon={ScanSearch} title={data?.length ? "No audits match these filters" : "No audits yet"} action={!data?.length ? <LinkButton href={`${base}/audits/new`} variant="primary" icon={ScanSearch}>Run an audit</LinkButton> : <Button onClick={() => router.replace(`${base}/audits`)}>Clear filters</Button>}>
            {data?.length ? undefined : "An audit fetches public pages, runs deterministic checks and records exactly what it saw."}
          </EmptyState>
        ) : (
          <>
            <table className="hidden w-full text-sm lg:table">
              <thead>
                <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium">Site</th>
                  <th className="px-4 py-2.5 font-medium">Scope</th>
                  <th className="px-4 py-2.5 text-right font-medium">Pages</th>
                  <th className="px-4 py-2.5 font-medium">Findings</th>
                  <th className="px-4 py-2.5 font-medium">Started</th>
                  <th className="px-4 py-2.5 text-right font-medium">Duration</th>
                  <th className="w-12 px-2 py-2.5"><span className="sr-only">Actions</span></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-subtle">
                {rows.map((a) => (
                  <tr key={a.id} className="cursor-pointer hover:bg-elevated/40" onClick={() => router.push(`${base}/audits/${a.id}`)}>
                    <td className="px-4 py-3"><AuditStatusBadge status={a.status} stale={a.stale} /></td>
                    <td className="px-4 py-3">
                      <Link href={`${base}/audits/${a.id}`} className="font-medium text-fg hover:text-accent-ink" onClick={(e) => e.stopPropagation()}>{a.siteName}</Link>
                    </td>
                    <td className="px-4 py-3 text-fg-2">
                      {MODE_LABEL[a.config.mode]}
                      <span className="text-fg-3">
                        {a.config.profile ? ` · ${PROFILES[a.config.profile].label}` : ""} · {describeLimits(a.config.maxPages, a.config.maxDepth)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right tabular">
                      <span className="text-fg">{a.progress.inspected}</span>
                      <span className="text-fg-3"> inspected</span>
                      {a.progress.failed ? <span className="block text-xs text-sev-medium">{a.progress.failed} failed</span> : null}
                    </td>
                    <td className="px-4 py-3">{a.findingCounts ? <SeverityCountsInline counts={a.findingCounts} compact /> : <span className="text-[13px] text-fg-3">—</span>}</td>
                    <td className="px-4 py-3 text-[13px] text-fg-2" title={fmtDateTime(a.startedAt)}>{fmtDateTime(a.startedAt)}</td>
                    <td className="px-4 py-3 text-right text-[13px] tabular text-fg-3">{fmtDuration(a.startedAt, a.finishedAt)}</td>
                    <td className="px-2 py-1.5 text-right"><DeleteAuditButton audit={a} onClick={() => setDeleting(a)} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <ul className="divide-y divide-line-subtle lg:hidden">
              {rows.map((a) => (
                <li key={a.id} className="flex items-start gap-1 pr-2">
                  <Link href={`${base}/audits/${a.id}`} className="block min-w-0 flex-1 px-4 py-3">
                    <span className="flex items-center justify-between gap-3">
                      <span className="truncate font-medium text-fg">{a.siteName}</span>
                      <AuditStatusBadge status={a.status} stale={a.stale} />
                    </span>
                    <span className="mt-1 block text-[13px] text-fg-3">
                      {MODE_LABEL[a.config.mode]} · {plural(a.progress.inspected, "page")} · {fmtAgo(a.startedAt)}
                    </span>
                    {a.findingCounts ? <span className="mt-1.5 block"><SeverityCountsInline counts={a.findingCounts} compact /></span> : null}
                  </Link>
                  <span className="pt-2"><DeleteAuditButton audit={a} onClick={() => setDeleting(a)} /></span>
                </li>
              ))}
            </ul>
          </>
        )}
      </Panel>
      <DeleteAuditDialog audit={deleting} onClose={() => setDeleting(null)} onDeleted={reload} />
      {siteRow ? <ClearAuditHistoryDialog site={siteRow} auditCount={data?.length ?? 0} open={clearing} onClose={() => setClearing(false)} onCleared={reload} /> : null}
    </>
  );
}

// ---------- new ----------

function preview(o: { mode: AuditMode; urlCount: number; sitemapUrl: string; includeImportant: boolean; importantCount: number; maxDepth: number | null; maxPages: number; checkLinks: boolean; categories: RuleCategory[]; scope: string[] }) {
  const lines: string[] = [];
  lines.push("Read robots.txt first and skip URLs it disallows for this crawler");
  if (o.mode === "single") lines.push("Inspect the one URL you entered");
  else if (o.mode === "list") lines.push(`Inspect ${plural(o.urlCount, "listed URL")}`);
  else lines.push(`Read URLs from ${o.sitemapUrl ? "the sitemap you entered" : "the sitemap declared in robots.txt, else /sitemap.xml"}`);
  if (o.includeImportant && o.importantCount) lines.push(`Also inspect the site's ${plural(o.importantCount, "important URL")}`);
  lines.push(o.maxDepth === null ? "Follow internal links with no depth limit" : o.maxDepth > 0 ? `Follow internal links up to ${plural(o.maxDepth, "click")} deep` : "Do not follow links");
  lines.push(`Stop after ${plural(o.maxPages, "URL")}`);
  lines.push(...o.scope);
  if (o.checkLinks) lines.push(`Status-check up to ${LIMITS.linkChecks} uncrawled internal link and image targets`);
  lines.push(`Run ${o.categories.length} of ${RULE_CATEGORIES.length} check categories`);
  return lines;
}

/** The form starts empty unless a link explicitly passed ?site=; keyed so a new ?site= (or none) resets it. */
export function NewAuditView() {
  const sp = useSearchParams();
  const requested = sp.get("site") ?? "";
  return <NewAuditForm key={requested} requestedSite={requested} />;
}

/** Re-point a user-entered URL at a new site: keep paths, drop absolute URLs from the previous host. */
const keepPath = (u: string) => (u.trim().startsWith("/") ? u.trim() : "");

function NewAuditForm({ requestedSite }: { requestedSite: string }) {
  const { ws, base, apiBase, sites } = useWs();
  const router = useRouter();
  const toast = useToast();
  const list = useMemo(() => sites.data ?? [], [sites.data]);
  const [siteId, setSiteId] = useState(requestedSite);
  const [mode, setMode] = useState<AuditMode>("single");
  const [single, setSingle] = useState("/");
  const [many, setMany] = useState("");
  const [sitemapUrl, setSitemapUrl] = useState("");
  const [chosenProfile, setProfile] = useState<ProfileId | null>(null);
  const [budget, setBudget] = useState<number>(PROFILES.full.budget);
  const [depth, setDepth] = useState<number | null>(PROFILES.custom.maxDepth);
  const [nonHtmlBudget, setNonHtmlBudget] = useState("");
  const [imageBudget, setImageBudget] = useState("");
  const [externalBudget, setExternalBudget] = useState("");
  const [include, setInclude] = useState("");
  const [exclude, setExclude] = useState("");
  const [subfolder, setSubfolder] = useState("");
  const [authUser, setAuthUser] = useState("");
  const [authPass, setAuthPass] = useState("");
  const settings = useApi<SettingsData>(`${apiBase}/settings`);
  const v2 = settings.data?.crawler.v2 ?? false;
  const canAuth = settings.data?.crawler.basicAuth ?? false;
  // Workspace audits default to Standard; Quick stays the default of the public hero form only.
  const profile: ProfileId = chosenProfile ?? "standard";
  const [categories, setCategories] = useState<RuleCategory[]>(RULE_CATEGORIES.map((c) => c.id));
  const [checkLinks, setCheckLinks] = useState(true);
  const [includeImportant, setIncludeImportant] = useState(true);
  const [aiCrawlers, setAiCrawlers] = useState<"" | "allow" | "block">("");
  const [renderChoice, setRenderChoice] = useState<RenderMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const site = list.find((s) => s.site.id === siteId);
  const changeSite = (id: string) => {
    setSiteId(id);
    setErr(null);
    setSingle((u) => keepPath(u) || "/");
    setMany((m) => m.split(/\s+/).map(keepPath).filter(Boolean).join("\n"));
    setSitemapUrl((u) => keepPath(u));
  };
  const origin = site?.site.origin ?? "";
  const toAbs = (u: string) => (u.trim().startsWith("/") && origin ? `${origin}${u.trim()}` : u.trim());
  const listUrls = many.split(/\s+/).map((u) => u.trim()).filter(Boolean);

  const p = PROFILES[profile];
  const askedPages = p.budgetEditable ? budget : p.budget;
  // A mode the profile does not take (after switching profile) falls back to the profile's default.
  const render: RenderMode = renderChoice && p.render.includes(renderChoice) ? renderChoice : p.render[0];
  const askedDepth = p.depthEditable ? depth : p.maxDepth;
  // Without crawler v2 the server clamps to the in-request engine's limits and notes it on the audit.
  const maxPages = v2 ? askedPages : Math.min(askedPages, LIMITS.maxPages);
  const maxDepth = v2 ? askedDepth : askedDepth === null ? LIMITS.maxDepth : Math.min(askedDepth, LIMITS.maxDepth);
  const custom = profile === "custom" && v2;
  const includes = ruleLines(include);
  const excludes = ruleLines(exclude);
  const scopeLines = custom
    ? [
        ...(subfolder.trim() ? [`Stay inside ${subfolder.trim()}`] : []),
        ...(includes.length ? [`Keep only URLs matching ${plural(includes.length, "include rule")}`] : []),
        ...(excludes.length ? [`Skip URLs matching ${plural(excludes.length, "exclude rule")}`] : []),
        ...(canAuth && authUser.trim() ? [`Sign in with basic auth as ${authUser.trim()} (this site only)`] : []),
      ]
    : [];
  const lines = preview({ mode, urlCount: listUrls.length, sitemapUrl, includeImportant, importantCount: site?.importantUrls ?? 0, maxDepth, maxPages, checkLinks, categories, scope: scopeLines });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (!site) return setErr(SITE_REQUIRED);
    if (mode === "list" && listUrls.length > LIMITS.maxListUrls) return setErr(`At most ${LIMITS.maxListUrls} URLs per audit.`);
    setBusy(true);
    try {
      const urls = mode === "single" ? [toAbs(single)] : mode === "list" ? listUrls.map(toAbs) : [];
      const r = await api<{ audit: AuditSummary; reused: boolean }>(`${apiBase}/audits`, {
        method: "POST",
        body: {
          siteId,
          mode,
          urls,
          sitemapUrl: mode === "sitemap" && sitemapUrl.trim() ? toAbs(sitemapUrl) : undefined,
          profile,
          ...(p.budgetEditable ? { budget } : {}),
          ...(p.depthEditable ? { maxDepth: depth } : {}),
          ...(custom && (subfolder.trim() || includes.length || excludes.length) ? { scope: { include: includes, exclude: excludes, subfolder: subfolder.trim() || undefined } } : {}),
          ...(custom && (nonHtmlBudget || imageBudget || externalBudget)
            ? { resourceBudgets: { ...(nonHtmlBudget ? { nonHtml: Number(nonHtmlBudget) } : {}), ...(imageBudget ? { images: Number(imageBudget) } : {}), ...(externalBudget ? { externalLinks: Number(externalBudget) } : {}) } }
            : {}),
          ...(custom && canAuth && authUser.trim() ? { auth: { username: authUser.trim(), password: authPass } } : {}),
          categories,
          checkLinks,
          includeImportant,
          ...(v2 && aiCrawlers ? { aiCrawlers } : {}),
          ...(v2 && p.render.length > 1 ? { render } : {}),
        },
      });
      if (r.reused) toast({ tone: "info", title: "An audit is already running for this site", detail: "Showing its progress instead of starting a second one." });
      router.push(`${base}/audits/${r.audit.id}`);
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : String(e2));
      setBusy(false);
    }
  };

  const crumbs = [{ label: "Audits", href: `${base}/audits` }, { label: "New audit" }];
  if (sites.error) return (<><PageHeader title="New audit" crumbs={crumbs} /><ErrorState error={sites.error} onRetry={sites.reload} /></>);
  if (sites.loading && !sites.data) return <PageSkeleton rows={4} />;
  if (list.length === 0) {
    return (
      <>
        <PageHeader title="New audit" crumbs={crumbs} />
        <Panel>
          <EmptyState icon={Globe} title="Add a site first" action={ws === "live" ? <LinkButton href={`${base}/sites?add=1`} variant="primary">Add a site</LinkButton> : undefined}>
            Audits belong to a site, so SiteSentry knows which links are internal and which expectations apply.
          </EmptyState>
        </Panel>
      </>
    );
  }

  return (
    <>
      <PageHeader title="New audit" crumbs={crumbs} description="Choose what to inspect. SiteSentry only fetches public pages, respects robots.txt and never changes your site." />
      <form onSubmit={submit} className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_340px]" noValidate>
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title="Target">
            <div className="flex flex-col gap-5">
              <Field label="Site" htmlFor="na-site">
                <Select id="na-site" value={site ? siteId : ""} onChange={(e) => (e.target.value === ADD_SITE ? router.push(`${base}/sites?add=1`) : changeSite(e.target.value))} aria-invalid={!site && !!err} aria-describedby={!site ? "na-site-hint" : undefined}>
                  <option value="">Choose a site</option>
                  {list.map((s) => <option key={s.site.id} value={s.site.id}>{siteOptionLabel(s.site)}</option>)}
                  {ws === "live" ? <option value={ADD_SITE}>Add new site +</option> : null}
                </Select>
                {!site ? <p id="na-site-hint" className="mt-1.5 text-xs text-fg-3">{SITE_REQUIRED}</p> : null}
              </Field>
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] font-medium text-fg">Input</span>
                <Segmented label="Input method" value={mode} onChange={setMode} options={[{ value: "single", label: "Single URL" }, { value: "list", label: "URL list" }, { value: "sitemap", label: "XML sitemap" }]} />
              </div>
              {mode === "single" ? (
                <Field label="URL" htmlFor="na-url" hint={origin ? `A path on ${cleanHost(origin)} or a full URL on that host.` : undefined}>
                  <Input id="na-url" value={single} onChange={(e) => setSingle(e.target.value)} className="font-mono" placeholder="/services/" />
                </Field>
              ) : mode === "list" ? (
                <Field label="URLs" htmlFor="na-urls" hint={`One per line, paths or full URLs. ${listUrls.length} of ${LIMITS.maxListUrls}.`}>
                  <Textarea id="na-urls" value={many} onChange={(e) => setMany(e.target.value)} className="min-h-36 font-mono text-[13px]" placeholder={"/\n/services/\n/contact"} />
                </Field>
              ) : (
                <Field label="Sitemap URL" htmlFor="na-sm" hint="Optional. Leave empty to use the robots.txt declaration, then /sitemap.xml. Sitemap indexes are followed (first 5 child sitemaps).">
                  <Input id="na-sm" value={sitemapUrl} onChange={(e) => setSitemapUrl(e.target.value)} className="font-mono" placeholder={site?.site.sitemapUrl ?? "/sitemap.xml"} />
                </Field>
              )}
            </div>
          </Panel>

          <Panel title="Crawl profile" description={`${p.label}: ${describeLimits(askedPages, askedDepth)}. ${p.use}.`}>
            <div className="grid gap-5 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5 sm:col-span-2">
                <Segmented label="Crawl profile" value={profile} onChange={setProfile} options={PROFILE_IDS.map((id) => ({ value: id, label: PROFILES[id].label }))} />
              </div>
              {settings.data && !v2 && (askedPages > maxPages || askedDepth !== maxDepth || profile === "custom") ? (
                <div className="sm:col-span-2">
                  <Notice tone="warn">
                    Crawler v2 is off on this server, so audits run on the in-request engine: at most {describeLimits(LIMITS.maxPages, LIMITS.maxDepth)}. This audit will cover {describeLimits(maxPages, maxDepth)} and say so in its coverage notes.
                    {profile === "custom" ? " Scope rules and basic auth need crawler v2." : ""}
                  </Notice>
                </div>
              ) : null}
              {p.budgetEditable ? (
                <Field label="URL budget" htmlFor="na-budget" hint={`1–${MAX_BUDGET.toLocaleString("en")}. The crawl stops here and the audit is marked partial.`}>
                  <Input id="na-budget" type="number" min={1} max={MAX_BUDGET} value={budget} onChange={(e) => setBudget(Math.max(1, Math.min(MAX_BUDGET, Math.floor(Number(e.target.value)) || 1)))} />
                </Field>
              ) : null}
              {p.depthEditable ? (
                <Field label="Link depth" htmlFor="na-depth" hint="Clicks from the start URLs. Orphan and inbound-link checks need depth ≥ 1.">
                  <div className="flex items-center gap-3">
                    <Input id="na-depth" type="number" min={0} max={MAX_DEPTH} value={depth ?? ""} disabled={depth === null} onChange={(e) => setDepth(Math.max(0, Math.min(MAX_DEPTH, Math.floor(Number(e.target.value)) || 0)))} />
                    <Checkbox label="Unlimited" checked={depth === null} onChange={(v) => setDepth(v ? null : PROFILES.custom.maxDepth)} />
                  </div>
                </Field>
              ) : null}
              {custom ? (
                <>
                  <Field label="Non-HTML URL budget" htmlFor="na-nonhtml" hint={`Optional. Feeds, JSON and files linked as pages. Default ${RESOURCE_BUDGET_DEFAULTS.nonHtml.toLocaleString("en")}.`}>
                    <Input id="na-nonhtml" type="number" min={0} max={MAX_BUDGET} value={nonHtmlBudget} onChange={(e) => setNonHtmlBudget(e.target.value)} />
                  </Field>
                  <Field label="Image budget" htmlFor="na-images" hint={`Optional. Image URLs to check. Default ${RESOURCE_BUDGET_DEFAULTS.images.toLocaleString("en")}.`}>
                    <Input id="na-images" type="number" min={0} max={MAX_BUDGET} value={imageBudget} onChange={(e) => setImageBudget(e.target.value)} />
                  </Field>
                  <Field label="External link budget" htmlFor="na-external" hint={`Optional. External links to check. Default ${RESOURCE_BUDGET_DEFAULTS.externalLinks.toLocaleString("en")}.`}>
                    <Input id="na-external" type="number" min={0} max={MAX_BUDGET} value={externalBudget} onChange={(e) => setExternalBudget(e.target.value)} />
                  </Field>
                  <div className="hidden sm:block" />
                  <Field label="Subfolder" htmlFor="na-sub" hint="Optional. Only URLs under this path, e.g. /blog/.">
                    <Input id="na-sub" value={subfolder} onChange={(e) => setSubfolder(e.target.value)} className="font-mono" placeholder="/blog/" />
                  </Field>
                  <div className="hidden sm:block" />
                  <Field label="Include rules" htmlFor="na-inc" hint="Optional. One regular expression per line; a URL must match one. Case-sensitive, tested against the full URL.">
                    <Textarea id="na-inc" value={include} onChange={(e) => setInclude(e.target.value)} className="min-h-20 font-mono text-[13px]" placeholder="/products/" />
                  </Field>
                  <Field label="Exclude rules" htmlFor="na-exc" hint="Optional. One regular expression per line; URLs matching any are skipped.">
                    <Textarea id="na-exc" value={exclude} onChange={(e) => setExclude(e.target.value)} className="min-h-20 font-mono text-[13px]" placeholder={"\\?sort=\n/tag/"} />
                  </Field>
                  {canAuth ? (
                    <>
                      <Field label="Basic auth user" htmlFor="na-au" hint="Optional, for staging sites. Sent only to this site's own origin.">
                        <Input id="na-au" value={authUser} onChange={(e) => setAuthUser(e.target.value)} autoComplete="off" />
                      </Field>
                      <Field label="Basic auth password" htmlFor="na-ap" hint="Stored encrypted with this crawl; never shown again.">
                        <Input id="na-ap" type="password" value={authPass} onChange={(e) => setAuthPass(e.target.value)} autoComplete="new-password" />
                      </Field>
                    </>
                  ) : (
                    <p className="text-xs text-fg-3 sm:col-span-2">Basic auth for staging sites needs CRAWLER_SECRET_KEY set on the server.</p>
                  )}
                </>
              ) : null}
              <Checkbox label="Check uncrawled link and image targets" hint={`Status checks of up to ${LIMITS.linkChecks} internal URLs found but not crawled.`} checked={checkLinks} onChange={setCheckLinks} />
              <Checkbox
                label="Include important URLs"
                hint={site ? (site.importantUrls ? `Adds this site's ${plural(site.importantUrls, "configured URL")}.` : "This site has no important URLs configured yet.") : "Adds the site's configured important URLs."}
                checked={includeImportant}
                onChange={setIncludeImportant}
              />
              {v2 ? (
                <Field
                  label="Rendering"
                  htmlFor="na-render"
                  hint={
                    p.render.length > 1
                      ? "Load pages in a headless browser after the crawl, for JavaScript content, lab Core Web Vitals and accessibility checks. Sampled renders one page per template."
                      : `The ${p.label} profile renders: ${RENDER_MODE_LABELS[p.render[0]].toLowerCase()}.${p.render[0] === "off" ? " Checks that need the rendered page do not run." : ""}`
                  }
                >
                  <Select id="na-render" value={render} disabled={p.render.length < 2} onChange={(e) => setRenderChoice(e.target.value as RenderMode)}>
                    {p.render.map((m) => (
                      <option key={m} value={m}>
                        {RENDER_MODE_LABELS[m]}
                      </option>
                    ))}
                  </Select>
                </Field>
              ) : null}
              {v2 ? (
                <Field label="AI crawlers" htmlFor="na-ai" hint="Should AI search crawlers (GPTBot, ClaudeBot, PerplexityBot…) be able to read this site? Used to judge robots.txt.">
                  <Select id="na-ai" value={aiCrawlers} onChange={(e) => setAiCrawlers(e.target.value as "" | "allow" | "block")}>
                    <option value="">Not set</option>
                    <option value="allow">Allow</option>
                    <option value="block">Block</option>
                  </Select>
                </Field>
              ) : null}
            </div>
          </Panel>

          <Panel title="Checks" description={`${categories.length} of ${RULE_CATEGORIES.length} categories selected`} actions={<Button size="sm" variant="ghost" onClick={() => setCategories(categories.length === RULE_CATEGORIES.length ? [] : RULE_CATEGORIES.map((c) => c.id))}>{categories.length === RULE_CATEGORIES.length ? "Clear all" : "Select all"}</Button>}>
            <div className="grid gap-4 sm:grid-cols-2">
              {RULE_CATEGORIES.map((c) => (
                <Checkbox key={c.id} label={c.label} hint={c.description} checked={categories.includes(c.id)} onChange={(v) => setCategories((xs) => (v ? [...xs, c.id] : xs.filter((x) => x !== c.id)))} />
              ))}
            </div>
          </Panel>
        </div>

        <div className="lg:sticky lg:top-20 lg:self-start">
          <Panel title="This audit will">
            <ol className="flex flex-col gap-2.5 text-sm">
              {lines.map((l, i) => (
                <li key={i} className="flex gap-2.5 text-fg-2">
                  <span className="mt-px font-mono text-xs text-fg-3">{String(i + 1).padStart(2, "0")}</span>
                  <span>{l}</span>
                </li>
              ))}
            </ol>
            {ws === "sample" ? (
              <div className="mt-4"><Notice tone="sample">Sample audits run the real engine against the bundled fictional sites. No network requests leave the server.</Notice></div>
            ) : null}
            {err ? <div className="mt-4"><Notice tone="error">{err}</Notice></div> : null}
            <Button type="submit" variant="primary" icon={Play} loading={busy} disabled={!site || categories.length === 0} className="mt-5 w-full">
              Start audit
            </Button>
            <p className="mt-2 text-center text-xs text-fg-3">Runs in steps while the progress page is open. You can cancel at any time.</p>
          </Panel>
        </div>
      </form>
    </>
  );
}
