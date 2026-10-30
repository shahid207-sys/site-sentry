"use client";
// Report of a v2 audit: the client report (HTML and PDF, rendered on the server from the same queries as the screens)
// and its read-only share links. A share link's token is shown once, when it is created; only its hash is stored.
import { Copy, Download, ExternalLink, Link2, Link2Off } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { CrawlOverview } from "@/lib/results/queries";
import type { ShareInfo } from "@/lib/report/shares";
import { api, ApiError, useApi } from "../../lib/api";
import { fmtDate, fmtDateTime, hostOf } from "../../lib/format";
import { useToast } from "../../overlays";
import { useWs } from "../../shell/context";
import { Button, EmptyState, ErrorState, Field, Input, LinkButton, Notice, PageHeader, PageSkeleton, Panel, Select, Tag } from "../../ui";

const EXPIRY = [
  { value: "7", label: "7 days" },
  { value: "30", label: "30 days" },
  { value: "90", label: "90 days" },
  { value: "", label: "Never (until revoked)" },
];

const status = (s: ShareInfo, now: number) => (s.revokedAt ? "Revoked" : s.expiresAt && Date.parse(s.expiresAt) <= now ? "Expired" : "Active");

export function ReportScreen({ auditId }: { auditId: string }) {
  const { base, apiBase, sites } = useWs();
  const toast = useToast();
  const auditApi = `${apiBase}/audits/${auditId}`;
  const ov = useApi<CrawlOverview>(`${auditApi}/overview`);
  const shares = useApi<ShareInfo[]>(ov.data?.analysed ? `${auditApi}/shares` : null);
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState("30");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const [now] = useState(() => Date.now());

  const site = ov.data ? sites.data?.find((s) => s.site.id === ov.data!.project)?.site : undefined;
  const name = site?.name ?? (ov.data ? hostOf(ov.data.siteOrigin) : "Audit");
  const crumbs = [{ label: "Reports", href: `${base}/reports` }, { label: name, href: `${base}/audits/${auditId}` }, { label: "Audit report" }];
  if (ov.error) return (<><PageHeader title="Audit report" crumbs={crumbs} /><ErrorState error={ov.error} onRetry={ov.reload} /></>);
  if (!ov.data) return <PageSkeleton rows={4} />;
  const o = ov.data;

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setErr(null);
    setBusy(true);
    try {
      const r = await api<{ path: string }>(`${auditApi}/shares`, { method: "POST", body: { password: password || null, expiresInDays: expiry ? Number(expiry) : null } });
      setCreated(`${window.location.origin}${r.path}`);
      setPassword("");
      shares.reload();
    } catch (e2) {
      setErr(e2 instanceof ApiError ? e2.message : String(e2));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (id: string) => {
    try {
      await api(`${auditApi}/shares/${id}`, { method: "DELETE" });
      toast({ tone: "info", title: "Share link revoked", detail: "It stopped working for everyone who has it." });
      shares.reload();
    } catch (e2) {
      toast({ tone: "error", title: "Could not revoke the link", detail: (e2 as Error).message });
    }
  };
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ tone: "ok", title: "Link copied" });
    } catch {
      toast({ tone: "error", title: "Could not copy", detail: "Select the link and copy it by hand." });
    }
  };

  return (
    <>
      <PageHeader crumbs={crumbs} title="Audit report" description={`${hostOf(o.siteOrigin)} · audited ${fmtDateTime(o.createdAt)}`} meta={<Tag>{o.profile}</Tag>} />
      {!o.analysed ? (
        <Notice tone="info" title="The report is available when the SEO checks have finished">
          The crawl of this audit has not been analysed yet. Open the audit to follow its progress.
        </Notice>
      ) : (
        <div className="flex flex-col gap-6">
          <Panel title="Client report" description="Scope, coverage, health score, issues by priority with evidence and fixes, and what changed since the previous audit. Every number is read from the same data as the audit screens.">
            <div className="flex flex-wrap gap-2">
              <LinkButton href={`${auditApi}/report/html`} target="_blank" icon={ExternalLink} variant="primary">Open report</LinkButton>
              <LinkButton href={`${auditApi}/report/pdf`} download="" icon={Download}>Download PDF</LinkButton>
            </div>
          </Panel>

          <Panel title="Share links" description="A read-only link to this report for someone without access to SiteSentry. Shared pages are never indexed and send no referrer.">
            <form onSubmit={create} className="grid gap-4 sm:grid-cols-[1fr_200px_auto] sm:items-end" noValidate>
              <Field label="Password (optional)" htmlFor="sh-pw" hint="At least 8 characters. Leave empty for a link anyone who has it can open." error={err}>
                <Input id="sh-pw" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
              <Field label="Expires after" htmlFor="sh-exp">
                <Select id="sh-exp" value={expiry} onChange={(e) => setExpiry(e.target.value)}>
                  {EXPIRY.map((x) => <option key={x.value} value={x.value}>{x.label}</option>)}
                </Select>
              </Field>
              <Button type="submit" icon={Link2} loading={busy}>Create link</Button>
            </form>
            {created ? (
              <div className="mt-4">
                <Notice tone="ok" title="Link created: copy it now" action={<Button size="sm" icon={Copy} onClick={() => copy(created)}>Copy</Button>}>
                  <span className="break-all font-mono text-[12.5px]" data-testid="share-url">{created}</span>
                  <span className="mt-1 block">It is shown only once: SiteSentry keeps a hash of it, not the link.</span>
                </Notice>
              </div>
            ) : null}
            <div className="mt-5">
              {shares.error ? (
                <ErrorState error={shares.error} onRetry={shares.reload} />
              ) : !shares.data ? null : shares.data.length === 0 ? (
                <EmptyState compact icon={Link2} title="No share links yet" />
              ) : (
                <table className="w-full text-left text-[13px]">
                  <caption className="sr-only">Share links of this report</caption>
                  <thead className="text-xs text-fg-2">
                    <tr className="border-b border-line">
                      <th scope="col" className="py-2 pr-3 font-medium">Created</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Password</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Expires</th>
                      <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                      <th scope="col" className="py-2 font-medium"><span className="sr-only">Actions</span></th>
                    </tr>
                  </thead>
                  <tbody>
                    {shares.data.map((s) => {
                      const st = status(s, now);
                      return (
                        <tr key={s.id} className="border-b border-line-subtle last:border-0">
                          <td className="py-2.5 pr-3">{fmtDateTime(s.createdAt)}</td>
                          <td className="py-2.5 pr-3">{s.hasPassword ? "Yes" : "No"}</td>
                          <td className="py-2.5 pr-3">{s.expiresAt ? fmtDate(s.expiresAt) : "Never"}</td>
                          <td className="py-2.5 pr-3">{st}</td>
                          <td className="py-2.5 text-right">
                            {st === "Active" ? <Button size="sm" variant="ghost" icon={Link2Off} onClick={() => revoke(s.id)}>Revoke</Button> : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>
        </div>
      )}
    </>
  );
}
