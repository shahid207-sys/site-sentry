"use client";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { ArrowRight, CircleAlert, FlaskConical, Globe, Link2, Pencil, Plus, ScanSearch, Search, Trash, Trash2 } from "lucide-react";
import { HEALTH_FORMULA, HEALTH_LABEL, HEALTH_NOTE, healthBand } from "@/lib/audit/health";
import { useMemo, useState, type FormEvent } from "react";
import type { PageIntent, PageType, Site } from "@/lib/model";
import type { SiteDetail, SiteRow } from "@/lib/views";
import { AddSiteForm, AuditLine, SeverityCountsInline } from "../domain";
import { api, ApiError, useApi } from "../lib/api";
import { fmtAgo, fmtDateTime, hostOf, plural, shortUrl } from "../lib/format";
import { ConfirmDialog, Modal, useToast } from "../overlays";
import { useWs } from "../shell/context";
import { ClearAuditHistoryDialog } from "./Audits";
import { ScheduledAudits } from "./Schedules";
import {
  AuditStatusBadge,
  Button,
  EmptyState,
  ErrorState,
  ExternalUrl,
  Field,
  HealthBar,
  IconTile,
  Input,
  LinkButton,
  Mono,
  Notice,
  PageHeader,
  PageSkeleton,
  Panel,
  SampleTag,
  Select,
  SeverityBadge,
  StatStrip,
  Tag,
  WorkflowBadge,
  cx,
} from "../ui";

const PAGE_TYPES: PageType[] = ["home", "service", "location", "product", "category", "article", "landing", "contact", "other"];
const typeLabel = (t: PageType) => t[0].toUpperCase() + t.slice(1);

// ---------- list ----------

export function SitesView() {
  const { ws, base, sites } = useWs();
  const sp = useSearchParams();
  const [adding, setAdding] = useState(sp.get("add") === "1");
  const [query, setQuery] = useState("");
  const { data, error, loading, reload } = sites;
  const canEdit = ws === "live";

  const header = (
    <PageHeader
      crumbs={[{ label: "Sites" }]}
      title="Sites"
      description="Every website in this workspace, its health and its latest audit."
      actions={canEdit && data?.length ? <Button variant="primary" icon={Plus} onClick={() => setAdding((a) => !a)} aria-expanded={adding}>Add site</Button> : undefined}
    />
  );
  if (error) return (<>{header}<ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return (<>{header}<PageSkeleton rows={3} /></>);
  const rawList = data ?? [];
  const q = query.trim().toLowerCase();
  const list = q ? rawList.filter((s) => s.site.name.toLowerCase().includes(q) || s.site.origin.toLowerCase().includes(q)) : rawList;
  const showAdd = canEdit && (adding || rawList.length === 0);

  const addPanel = showAdd ? (
    <Panel title={rawList.length ? "Add a new website" : "Add your first site"} description="Save the site, or save it and start a first audit right away.">
      <AddSiteForm autoFocus={adding} onCreated={() => setAdding(false)} />
    </Panel>
  ) : null;

  return (
    <>
      {header}
      {ws === "sample" ? (
        <div className="mb-6">
          <Notice tone="sample" title="Sample sites are read-only">
            You can run audits, create tasks and verify fixes here, but adding or editing sites happens in{" "}
            <Link href="/live/sites" className="text-fg underline underline-offset-4">your workspace</Link>.
          </Notice>
        </div>
      ) : null}

      {rawList.length === 0 ? (
        ws === "live" ? (
          <>
            {addPanel}
            <p className="mt-4 text-sm text-fg-3">
              Want to look around first? <Link className="font-medium text-accent-ink hover:underline" href="/sample/sites">Open the sample workspace</Link>.
            </p>
          </>
        ) : (
          <Panel><EmptyState icon={FlaskConical} title="No sample sites">Reset the sample workspace from Settings.</EmptyState></Panel>
        )
      ) : (
        <div className={cx("grid grid-cols-1 gap-6", showAdd && "xl:grid-cols-[minmax(0,1fr)_400px]")}>
          <Panel
            flush
            title={plural(rawList.length, "website")}
            actions={
              <label className="relative block w-full sm:w-64">
                <span className="sr-only">Search sites</span>
                <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-3" aria-hidden />
                <Input type="search" placeholder="Search websites…" value={query} onChange={(e) => setQuery(e.target.value)} className="h-9 pl-9" />
              </label>
            }
          >
            {list.length === 0 ? (
              <EmptyState compact icon={Globe} title="No sites match your search" />
            ) : (
              <>
                <table className="hidden w-full text-sm xl:table">
                  <thead>
                    <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
                      <th className="px-5 py-3 font-medium">Website</th>
                      <th className="px-4 py-3 font-medium">Health score</th>
                      <th className="px-4 py-3 font-medium">Open issues</th>
                      <th className="px-4 py-3 font-medium">Last audit</th>
                      <th className="w-px px-5 py-3"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-subtle">
                    {list.map((s) => (
                      <SiteTableRow key={s.site.id} s={s} base={base} />
                    ))}
                  </tbody>
                </table>
                <ul className="divide-y divide-line-subtle xl:hidden">
                  {list.map((s) => {
                    const a = s.runningAudit ?? s.lastAudit;
                    return (
                      <li key={s.site.id}>
                        <Link href={`${base}/sites/${s.site.id}`} className="flex items-center gap-3 px-5 py-3.5 hover:bg-surface-secondary">
                          <span className="min-w-0 flex-1">
                            <span className="flex items-center justify-between gap-3">
                              <span className="truncate font-semibold text-fg">{s.site.name}</span>
                              {s.health !== null ? <HealthBar score={s.health} /> : <span className="text-xs text-fg-3">Not audited</span>}
                            </span>
                            <span className="block truncate font-mono text-xs text-fg-3">{hostOf(s.site.origin)}</span>
                            <span className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                              <SeverityCountsInline counts={s.open} compact />
                              <span className="text-xs text-fg-3">{a ? `Audited ${fmtAgo(a.startedAt)}` : "Never audited"}</span>
                            </span>
                          </span>
                          <ArrowRight className="size-4 shrink-0 text-fg-3" aria-hidden />
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
          </Panel>
          {addPanel}
        </div>
      )}
    </>
  );
}

function SiteTableRow({ s, base }: { s: SiteRow; base: string }) {
  const a = s.runningAudit ?? s.lastAudit;
  return (
    <tr className="transition-colors hover:bg-surface-secondary">
      <td className="px-5 py-3.5">
        <span className="flex items-center gap-3">
          <IconTile icon={Globe} tone="neutral" size="sm" />
          <span className="min-w-0">
            <Link href={`${base}/sites/${s.site.id}`} className="block truncate font-semibold text-fg hover:text-accent-ink">
              {s.site.name}
            </Link>
            <span className="block truncate font-mono text-xs text-fg-3">{hostOf(s.site.origin)}</span>
          </span>
        </span>
      </td>
      <td className="px-4 py-3.5" title={s.health !== null ? `${HEALTH_FORMULA}. ${HEALTH_NOTE}` : undefined}>
        {s.health !== null ? (
          <span className="inline-flex items-center gap-2">
            <HealthBar score={s.health} />
            <span className="text-xs text-fg-3">{HEALTH_LABEL[healthBand(s.health)]}</span>
          </span>
        ) : (
          <span className="text-[13px] text-fg-3">Not audited</span>
        )}
      </td>
      <td className="px-4 py-3.5">
        <Link href={`${base}/issues?site=${s.site.id}`} className="inline-flex min-w-max rounded-md hover:opacity-80" aria-label={`${s.openTotal} open issues on ${s.site.name}`}>
          <SeverityCountsInline counts={s.open} compact />
        </Link>
      </td>
      <td className="px-4 py-3.5">
        {a ? (
          <Link href={`${base}/audits/${a.id}`} className="inline-flex items-center gap-2">
            <AuditStatusBadge status={a.status} stale={a.stale} />
            <span className="whitespace-nowrap text-[13px] text-fg-2" title={fmtDateTime(a.startedAt)}>{fmtAgo(a.startedAt)}</span>
          </Link>
        ) : (
          <span className="text-[13px] text-fg-3">Never audited</span>
        )}
      </td>
      <td className="px-5 py-3.5">
        <span className="flex justify-end gap-1">
                    <LinkButton href={`${base}/sites/${s.site.id}`} size="sm">View</LinkButton>
        </span>
      </td>
    </tr>
  );
}

// ---------- detail ----------

export function SiteDetailView() {
  const { siteId } = useParams<{ siteId: string }>();
  const { ws, base, apiBase, sites } = useWs();
  const router = useRouter();
  const toast = useToast();
  const res = useApi<SiteDetail>(`${apiBase}/sites/${siteId}`);
  const [editing, setEditing] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const canEdit = ws === "live";
  const { data, error, loading, reload } = res;

  const crumbs = [{ label: "Sites", href: `${base}/sites` }, { label: data?.site.name ?? "Site" }];
  if (error) return (<><PageHeader title="Site" crumbs={crumbs} /><ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return <PageSkeleton />;
  if (!data) return null;
  const { site } = data;

  const doDelete = async () => {
    setDeleting(true);
    try {
      const r = await api<{ auditsDeleted: number }>(`${apiBase}/sites/${site.id}`, { method: "DELETE" });
      toast({ tone: "ok", title: `${site.name} deleted`, detail: `${plural(r.auditsDeleted, "audit")} and its tasks were removed.` });
      await sites.reload();
      router.push(`${base}/sites`);
    } catch (e) {
      toast({ tone: "error", title: "Could not delete the site", detail: (e as Error).message });
      setDeleting(false);
      setConfirmDelete(false);
    }
  };

  const finished = data.audits.filter((a) => a.status !== "running");
  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={site.name}
        meta={
          <>
            <ExternalUrl url={site.origin} className="font-mono text-[13px] text-fg-2">{hostOf(site.origin)}</ExternalUrl>
            {ws === "sample" ? <SampleTag /> : null}
            {site.sitemapUrl ? <span className="text-[13px] text-fg-3">Sitemap: <Mono>{shortUrl(site.sitemapUrl)}</Mono></span> : null}
          </>
        }
        actions={
          <>
            {canEdit ? <Button icon={Pencil} onClick={() => setEditing(true)}>Edit</Button> : null}
            <LinkButton href={`${base}/audits/new?site=${site.id}`} variant="primary" icon={ScanSearch}>Run audit</LinkButton>
          </>
        }
      />

      <StatStrip
        items={[
          { label: "Open issues", value: data.openTotal, hint: <SeverityCountsInline counts={data.open} />, href: `${base}/issues?site=${site.id}` },
          { label: "Resolved", value: data.resolvedTotal, hint: "Re-crawled and no longer detected" },
          { label: "Active tasks", value: data.tasks.active, hint: data.tasks.ready ? `${data.tasks.ready} ready to verify` : "In the fix queue", href: `${base}/tasks?site=${site.id}` },
          { label: "Audits", value: data.audits.length, hint: finished[0] ? `Last ${fmtAgo(finished[0].startedAt)}` : "None yet" },
        ]}
      />

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <Panel
          title="Highest-priority open issues"
          flush
          actions={data.openTotal ? <LinkButton size="sm" variant="ghost" href={`${base}/issues?site=${site.id}`}>All {data.openTotal}</LinkButton> : undefined}
        >
          {data.topIssues.length ? (
            <ul className="divide-y divide-line-subtle">
              {data.topIssues.map((i) => (
                <li key={i.fingerprint}>
                  <Link href={`${base}/issues/${encodeURIComponent(i.fingerprint)}?site=${site.id}`} className="flex items-center gap-3 px-4 py-3 hover:bg-elevated/60">
                    <SeverityBadge severity={i.finding.priority.severity} priority={i.finding.priority.level} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm text-fg">{i.finding.title}</span>
                      <span className="block truncate font-mono text-xs text-fg-3">{i.finding.scope.kind === "page" ? shortUrl(i.finding.pageUrl) : i.finding.ruleCode}</span>
                    </span>
                    {i.task ? <WorkflowBadge status={i.task.workflowStatus} /> : <span className="hidden text-xs text-fg-3 sm:inline">No task</span>}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState compact icon={CircleAlert} title={data.audits.length ? "No open issues" : "Not audited yet"} action={data.audits.length ? undefined : <LinkButton href={`${base}/audits/new?site=${site.id}`} variant="primary" icon={ScanSearch}>Run the first audit</LinkButton>}>
              {data.audits.length ? "The latest audits found nothing open on this site." : "Run an audit to see what SiteSentry finds."}
            </EmptyState>
          )}
        </Panel>

        <Panel title="Audit history" flush actions={finished.length >= 2 ? <LinkButton size="sm" variant="ghost" href={`${base}/audits/${finished[0].id}/compare`}>Compare latest</LinkButton> : undefined}>
          {data.audits.length ? (
            <ul className="divide-y divide-line-subtle">
              {data.audits.slice(0, 8).map((a) => (
                <li key={a.id}><AuditLine a={a} showSite={false} /></li>
              ))}
            </ul>
          ) : (
            <EmptyState compact icon={ScanSearch} title="No audits yet" />
          )}
        </Panel>
      </div>

      <ImportantUrls detail={data} canEdit={canEdit} onChange={reload} />

      {canEdit ? <ScheduledAudits site={site} /> : null}

      {canEdit ? (
        <Panel className="mt-6" title="Danger zone">
          <div className="flex flex-col divide-y divide-line-subtle">
            <div className="flex flex-col gap-3 pb-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-fg-2">
                <span className="block font-medium text-fg">Delete audit history</span>
                Removes all {plural(data.audits.length, "audit")}, their findings and the fix tasks for this site. The site and its important URLs stay, so you can start fresh.
              </p>
              <Button
                variant="danger"
                icon={Trash2}
                onClick={() => setConfirmClear(true)}
                disabled={!data.audits.length || data.audits.some((a) => a.status === "running")}
                title={data.audits.some((a) => a.status === "running") ? "An audit is running. Cancel it first." : undefined}
              >
                Delete audit history
              </Button>
            </div>
            <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-fg-2">
                <span className="block font-medium text-fg">Delete site</span>
                Permanently removes the site with its audits, snapshots, tasks and verification history.
              </p>
              <Button variant="danger" icon={Trash} onClick={() => setConfirmDelete(true)}>Delete site</Button>
            </div>
          </div>
        </Panel>
      ) : null}

      {editing ? <EditSiteModal site={site} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); void reload(); void sites.reload(); }} /> : null}
      <ClearAuditHistoryDialog site={site} auditCount={data.audits.length} open={confirmClear} onClose={() => setConfirmClear(false)} onCleared={reload} />
      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={doDelete}
        busy={deleting}
        danger
        title={`Delete ${site.name}?`}
        confirmLabel="Delete permanently"
        description={`This removes ${plural(data.audits.length, "audit")}, ${plural(data.pages.length, "important URL")} and every task for this site. It cannot be undone.`}
      />
    </>
  );
}

function EditSiteModal({ site, onClose, onSaved }: { site: Site; onClose: () => void; onSaved: () => void }) {
  const { apiBase } = useWs();
  const toast = useToast();
  const [name, setName] = useState(site.name);
  const [sitemapUrl, setSitemapUrl] = useState(site.sitemapUrl ?? "");
  const [notes, setNotes] = useState(site.notes ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await api(`${apiBase}/sites/${site.id}`, { method: "PATCH", body: { name, sitemapUrl: sitemapUrl.trim() || null, notes } });
      toast({ tone: "ok", title: "Site saved" });
      onSaved();
    } catch (e2) {
      setErr((e2 as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Edit site" footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => save()}>Save</Button></>}>
      <form onSubmit={save} className="flex flex-col gap-4">
        <Field label="Name" htmlFor="es-name"><Input id="es-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={100} /></Field>
        <Field label="Origin" hint="The origin can't be changed: audits and issue identities depend on it. Add a new site instead.">
          <Input value={site.origin} disabled />
        </Field>
        <Field label="Sitemap URL" htmlFor="es-sm" hint="Optional. Otherwise robots.txt Sitemap: lines are used, then /sitemap.xml.">
          <Input id="es-sm" value={sitemapUrl} onChange={(e) => setSitemapUrl(e.target.value)} placeholder={`${site.origin}/sitemap.xml`} />
        </Field>
        <Field label="Notes" htmlFor="es-notes"><Input id="es-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={5000} /></Field>
        {err ? <p className="text-[13px] text-sev-high" role="alert">{err}</p> : null}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

// ---------- important URLs ----------

function ImportantUrls({ detail, canEdit, onChange }: { detail: SiteDetail; canEdit: boolean; onChange: () => void }) {
  const { apiBase } = useWs();
  const toast = useToast();
  const [editing, setEditing] = useState<PageIntent | "new" | null>(null);
  const [removing, setRemoving] = useState<PageIntent | null>(null);
  const [busy, setBusy] = useState(false);
  const [label, setLabel] = useState("");
  const labels = useMemo(() => [...new Set(detail.pages.flatMap((p) => p.labels))].sort(), [detail.pages]);
  const rows = label ? detail.pages.filter((p) => p.labels.includes(label) || p.pageType === label) : detail.pages;

  const remove = async () => {
    if (!removing) return;
    setBusy(true);
    try {
      await api(`${apiBase}/sites/${detail.site.id}/pages/${removing.id}`, { method: "DELETE" });
      toast({ tone: "ok", title: "URL removed", detail: shortUrl(removing.url) });
      setRemoving(null);
      onChange();
    } catch (e) {
      toast({ tone: "error", title: "Could not remove", detail: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Panel
      className="mt-6"
      title="Important URLs"
      description="What you intend for each key page. Canonical and indexability checks compare against this; without it they only report what they saw."
      flush
      actions={
        <>
          {labels.length ? (
            <Select aria-label="Filter by label or type" value={label} onChange={(e) => setLabel(e.target.value)} className="h-8 w-40 text-[13px]">
              <option value="">All labels</option>
              {[...new Set([...detail.pages.map((p) => p.pageType), ...labels])].map((l) => <option key={l} value={l}>{l}</option>)}
            </Select>
          ) : null}
          {canEdit ? <Button size="sm" icon={Plus} onClick={() => setEditing("new")}>Add URL</Button> : null}
        </>
      }
    >
      {detail.pages.length === 0 ? (
        <EmptyState compact icon={Link2} title="No important URLs yet" action={canEdit ? <Button icon={Plus} onClick={() => setEditing("new")}>Add a URL</Button> : undefined}>
          Add the pages that matter most: home, services, locations, landing pages. They are audited every time and ranked higher when something is wrong.
        </EmptyState>
      ) : (
        <>
          <table className="hidden w-full table-fixed text-sm lg:table">
            <thead>
              <tr className="border-b border-line-subtle text-left text-xs text-fg-3">
                <th className="w-[34%] px-4 py-2.5 font-medium">URL</th>
                <th className="w-[11%] px-4 py-2.5 font-medium">Type</th>
                <th className="w-[17%] px-4 py-2.5 font-medium">Labels</th>
                <th className="w-[12%] px-4 py-2.5 font-medium">Intended</th>
                <th className="px-4 py-2.5 font-medium">Expected canonical</th>
                {canEdit ? <th className="w-24 px-4 py-2.5"><span className="sr-only">Actions</span></th> : null}
              </tr>
            </thead>
            <tbody className="divide-y divide-line-subtle">
              {rows.map((p) => (
                <tr key={p.id} className="hover:bg-elevated/40">
                  <td className="px-4 py-2.5"><Mono className="evidence text-fg">{shortUrl(p.url)}</Mono></td>
                  <td className="px-4 py-2.5 text-fg-2">{typeLabel(p.pageType)}</td>
                  <td className="px-4 py-2.5"><span className="flex flex-wrap gap-1">{p.labels.length ? p.labels.map((l) => <Tag key={l}>{l}</Tag>) : <span className="text-fg-3">—</span>}</span></td>
                  <td className="px-4 py-2.5 text-fg-2">{p.indexability === "noindex" ? "Noindex" : p.indexability === "index" ? "Indexed" : <span className="text-fg-3">Not set</span>}</td>
                  <td className="px-4 py-2.5">{p.canonicalUrl ? <Mono className="evidence text-fg-2">{p.canonicalUrl === p.url ? "Self" : p.canonicalUrl}</Mono> : <span className="text-fg-3">Not set</span>}</td>
                  {canEdit ? (
                    <td className="px-2 py-1.5 text-right">
                      <button type="button" className="rounded p-1.5 text-fg-3 hover:bg-hover hover:text-fg" aria-label={`Edit ${shortUrl(p.url)}`} onClick={() => setEditing(p)}><Pencil className="size-4" /></button>
                      <button type="button" className="rounded p-1.5 text-fg-3 hover:bg-hover hover:text-sev-high" aria-label={`Remove ${shortUrl(p.url)}`} onClick={() => setRemoving(p)}><Trash className="size-4" /></button>
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
          <ul className="divide-y divide-line-subtle lg:hidden">
            {rows.map((p) => (
              <li key={p.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <Mono className="evidence block text-fg">{shortUrl(p.url)}</Mono>
                  <p className="mt-1 text-[13px] text-fg-2">
                    {typeLabel(p.pageType)} · {p.indexability === "noindex" ? "Noindex" : p.indexability === "index" ? "Indexed" : "Indexability not set"}
                    {p.canonicalUrl ? ` · Canonical ${p.canonicalUrl === p.url ? "self" : shortUrl(p.canonicalUrl)}` : ""}
                  </p>
                  {p.labels.length ? <div className="mt-1.5 flex flex-wrap gap-1">{p.labels.map((l) => <Tag key={l}>{l}</Tag>)}</div> : null}
                </div>
                {canEdit ? (
                  <div className="flex shrink-0">
                    <button type="button" className="rounded p-2 text-fg-3 hover:bg-hover hover:text-fg" aria-label={`Edit ${shortUrl(p.url)}`} onClick={() => setEditing(p)}><Pencil className="size-4" /></button>
                    <button type="button" className="rounded p-2 text-fg-3 hover:bg-hover hover:text-sev-high" aria-label={`Remove ${shortUrl(p.url)}`} onClick={() => setRemoving(p)}><Trash className="size-4" /></button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </>
      )}
      {editing ? <IntentModal site={detail.site} intent={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); onChange(); }} /> : null}
      <ConfirmDialog open={!!removing} onClose={() => setRemoving(null)} onConfirm={remove} busy={busy} danger title="Remove this important URL?" confirmLabel="Remove" description={removing ? <Mono>{removing.url}</Mono> : null}>
        <p className="text-sm text-fg-2">Past audits keep their snapshots. Future audits will stop comparing this page against your expectations.</p>
      </ConfirmDialog>
    </Panel>
  );
}

function IntentModal({ site, intent, onClose, onSaved }: { site: Site; intent: PageIntent | null; onClose: () => void; onSaved: () => void }) {
  const { apiBase } = useWs();
  const toast = useToast();
  const [url, setUrl] = useState(intent ? shortUrl(intent.url) : "/");
  const [pageType, setPageType] = useState<PageType>(intent?.pageType ?? "other");
  const [labels, setLabels] = useState(intent?.labels.join(", ") ?? "");
  const [indexability, setIndexability] = useState<"" | "index" | "noindex">(intent?.indexability ?? "index");
  const [canonMode, setCanonMode] = useState<"unset" | "self" | "other">(!intent?.canonicalUrl ? (intent ? "unset" : "self") : intent.canonicalUrl === intent.url ? "self" : "other");
  const [canonical, setCanonical] = useState(intent?.canonicalUrl && intent.canonicalUrl !== intent.url ? intent.canonicalUrl : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    setErr(null);
    const full = url.trim().startsWith("/") ? `${site.origin}${url.trim()}` : url.trim();
    const canonicalUrl = canonMode === "unset" ? null : canonMode === "self" ? full : canonical.trim();
    if (canonMode === "other" && !canonicalUrl) return setErr("Enter the expected canonical URL, or choose another option.");
    setBusy(true);
    try {
      await api(`${apiBase}/sites/${site.id}/pages`, {
        method: "PUT",
        body: { url: full, pageType, labels: labels.split(",").map((l) => l.trim()).filter(Boolean), indexability: indexability || null, canonicalUrl },
      });
      toast({ tone: "ok", title: intent ? "URL updated" : "URL added", detail: "Applies from the next audit." });
      onSaved();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} wide title={intent ? "Edit important URL" : "Add an important URL"} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={() => save()}>{intent ? "Save" : "Add URL"}</Button></>}>
      <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
        <Field className="sm:col-span-2" label="URL" htmlFor="pi-url" hint={`A path on ${hostOf(site.origin)}, or a full URL on the same host.`}>
          <Input id="pi-url" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!!intent} className="font-mono" autoFocus={!intent} />
        </Field>
        <Field label="Page type" htmlFor="pi-type">
          <Select id="pi-type" value={pageType} onChange={(e) => setPageType(e.target.value as PageType)}>
            {PAGE_TYPES.map((t) => <option key={t} value={t}>{typeLabel(t)}</option>)}
          </Select>
        </Field>
        <Field label="Labels" htmlFor="pi-labels" hint="Comma-separated: service, location, campaign…">
          <Input id="pi-labels" value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="emergency, downtown" />
        </Field>
        <Field label="Intended indexing" htmlFor="pi-index" hint="An unexpected noindex is only reported when you say the page should be indexed.">
          <Select id="pi-index" value={indexability} onChange={(e) => setIndexability(e.target.value as typeof indexability)}>
            <option value="index">Should be indexed</option>
            <option value="noindex">Should be noindex</option>
            <option value="">Not specified</option>
          </Select>
        </Field>
        <Field label="Expected canonical" htmlFor="pi-canon">
          <Select id="pi-canon" value={canonMode} onChange={(e) => setCanonMode(e.target.value as typeof canonMode)}>
            <option value="self">Itself (self-referencing)</option>
            <option value="other">Another URL…</option>
            <option value="unset">Not specified</option>
          </Select>
        </Field>
        {canonMode === "other" ? (
          <Field className="sm:col-span-2" label="Canonical URL" htmlFor="pi-canon-url">
            <Input id="pi-canon-url" value={canonical} onChange={(e) => setCanonical(e.target.value)} placeholder={`${site.origin}/…`} className="font-mono" />
          </Field>
        ) : null}
        {err ? <p className="text-[13px] text-sev-high sm:col-span-2" role="alert">{err}</p> : null}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}


