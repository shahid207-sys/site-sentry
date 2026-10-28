"use client";
import Link from "next/link";
import { RotateCcw, Save, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { RULE_CATEGORIES, type Severity } from "@/lib/audit/types";
import type { SampleState } from "@/lib/model";
import type { SettingsData } from "@/lib/views";
import { api, useApi } from "../lib/api";
import { ConfirmDialog, useToast } from "../overlays";
import { useWs } from "../shell/context";
import { Button, CertaintyBadge, DefList, ErrorState, Field, Input, Mono, PageHeader, PageSkeleton, Panel, Segmented, Select, SeverityBadge, cx } from "../ui";

const SAMPLE_STATES: { value: SampleState; label: string; help: string }[] = [
  { value: "original", label: "Original", help: "The sites as first audited, before any fixes." },
  { value: "current", label: "Partly fixed", help: "Some fixes deployed, one template regression. The seeded audits end here." },
  { value: "fixed", label: "Fully fixed", help: "Every seeded issue fixed: verifications should pass." },
  { value: "offline", label: "Offline", help: "Every request fails: shows inconclusive verification and failed audits." },
];

export function SettingsView() {
  const { ws, apiBase } = useWs();
  const toast = useToast();
  const { data, error, loading, reload, setData } = useApi<SettingsData>(`${apiBase}/settings`);
  const [thin, setThin] = useState<string | null>(null);
  const [h1, setH1] = useState<"warn" | "ignore" | null>(null);
  const [overrides, setOverrides] = useState<Record<string, Severity> | null>(null);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [simBusy, setSimBusy] = useState(false);
  const readOnly = ws === "sample";

  const checks = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (data?.checks ?? []).filter((c) => (!cat || c.category === cat) && (!t || `${c.code} ${c.ruleName} ${c.why}`.toLowerCase().includes(t)));
  }, [data, q, cat]);

  const header = <PageHeader crumbs={[{ label: "Settings" }]} title="Settings" description={readOnly ? "The sample workspace's rule settings are fixed so its results stay reproducible. Its simulator is below." : "Rule thresholds and severity apply to new audits. Existing findings keep the criteria they were created with."} />;
  if (error) return (<>{header}<ErrorState error={error} onRetry={reload} /></>);
  if (loading && !data) return <PageSkeleton rows={8} />;
  if (!data) return null;

  const ov = overrides ?? data.settings.severityOverrides;
  const dirty = thin !== null || h1 !== null || overrides !== null;
  const save = async () => {
    const n = thin === null ? undefined : Number(thin);
    if (n !== undefined && (!Number.isInteger(n) || n < 0 || n > 5000)) return toast({ tone: "error", title: "Thin-content threshold must be a whole number from 0 to 5000" });
    setSaving(true);
    try {
      const next = await api<SettingsData>(`${apiBase}/settings`, {
        method: "PUT",
        body: { ruleConfig: { ...(n !== undefined ? { thinContentWords: n } : {}), ...(h1 ? { multipleH1: h1 } : {}) }, ...(overrides ? { severityOverrides: overrides } : {}) },
      });
      setData(next);
      setThin(null);
      setH1(null);
      setOverrides(null);
      toast({ tone: "ok", title: "Settings saved", detail: "They apply to the next audit." });
    } catch (e) {
      toast({ tone: "error", title: "Not saved", detail: (e as Error).message });
    } finally {
      setSaving(false);
    }
  };
  const setSim = async (body: { state: SampleState } | { reset: true }) => {
    setSimBusy(true);
    try {
      const next = await api<SettingsData>(`${apiBase}/sample`, { method: "PUT", body });
      setData(next);
      toast({ tone: "ok", title: "reset" in body ? "Sample workspace restored" : `Simulated sites: ${SAMPLE_STATES.find((s) => s.value === next.sampleState)?.label}`, detail: "reset" in body ? "Tasks and audits created since were discarded." : "New audits and verifications will see this version." });
      setConfirmReset(false);
    } catch (e) {
      toast({ tone: "error", title: "Could not update the sample", detail: (e as Error).message });
    } finally {
      setSimBusy(false);
    }
  };

  return (
    <>
      {header}
      <div className="flex flex-col gap-6">
        {readOnly && data.sampleState ? (
          <Panel title="Sample site simulator" description="Switch which version of the fictional sites is “deployed”, then run an audit or verify a task to see each outcome.">
            <Segmented<SampleState> label="Simulated site version" value={data.sampleState} onChange={(v) => setSim({ state: v })} options={SAMPLE_STATES.map((s) => ({ value: s.value, label: s.label }))} />
            <p className="mt-2 text-[13px] text-fg-2">{SAMPLE_STATES.find((s) => s.value === data.sampleState)?.help}</p>
            <div className="mt-5 flex flex-col gap-3 border-t border-line-subtle pt-4 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-[13px] text-fg-3">Restore the deterministic seed: two sites, four audits, six tasks.</p>
              <Button icon={RotateCcw} onClick={() => setConfirmReset(true)} disabled={simBusy}>Reset sample workspace</Button>
            </div>
          </Panel>
        ) : null}

        <Panel title="Rule thresholds">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Thin content threshold" htmlFor="s-thin" hint="Pages with fewer main-content words are flagged as possibly thin. A heuristic, never a quality verdict.">
              <Input id="s-thin" type="number" min={0} max={5000} value={thin ?? String(data.settings.ruleConfig.thinContentWords)} onChange={(e) => setThin(e.target.value)} disabled={readOnly} />
            </Field>
            <Field label="Multiple <h1> elements" htmlFor="s-h1" hint="Valid HTML; some teams treat it as a convention.">
              <Select id="s-h1" value={h1 ?? data.settings.ruleConfig.multipleH1} onChange={(e) => setH1(e.target.value as "warn" | "ignore")} disabled={readOnly}>
                <option value="warn">Report as a warning</option>
                <option value="ignore">Don&apos;t report</option>
              </Select>
            </Field>
          </div>
        </Panel>

        <Panel
          title="Checks and severity"
          description={`${data.checks.length} deterministic checks. Override a check's base severity; priority still accounts for page importance, scope and certainty.`}
          flush
          actions={
            <>
              <label className="relative">
                <span className="sr-only">Search checks</span>
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-fg-3" aria-hidden />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search checks" className="h-8 w-44 pl-8 text-[13px]" />
              </label>
              <Select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} className="h-8 w-auto text-[13px]">
                <option value="">All categories</option>
                {RULE_CATEGORIES.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
              </Select>
            </>
          }
        >
          <ul className="divide-y divide-line-subtle">
            {checks.map((c) => {
              const cur = ov[c.code];
              return (
                <li key={c.code} className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_auto] md:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Mono className="text-fg">{c.code}</Mono>
                      <CertaintyBadge certainty={c.certainty} />
                      {c.needsConfig ? <span className="text-xs text-fg-3">needs URL intent</span> : null}
                    </div>
                    <p className="mt-1 text-[13px] text-fg-2">{c.why}</p>
                  </div>
                  <div className="flex items-center gap-2">
                    {readOnly ? <SeverityBadge severity={c.severity} /> : <Select
                      aria-label={`Severity for ${c.code}`}
                      value={cur ?? ""}
                      onChange={(e) => {
                        const next = { ...ov };
                        if (e.target.value) next[c.code] = e.target.value as Severity;
                        else delete next[c.code];
                        setOverrides(next);
                      }}
                      className={cx("h-8 w-40 text-[13px]", cur && "border-accent/50")}
                    >
                      <option value="">Default ({c.severity})</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </Select>}
                  </div>
                </li>
              );
            })}
            {checks.length === 0 ? <li className="px-4 py-8 text-center text-sm text-fg-3">No checks match.</li> : null}
          </ul>
        </Panel>

        <Panel title="Data and scanning">
          <DefList
            items={[
              { label: "Storage", value: data.storage.ephemeral ? <span className="text-sev-medium">Temporary: this deployment keeps data in /tmp, which is lost on restart. Set SITE_SENTRY_DATA_DIR to a persistent volume.</span> : data.storage.persistent ? "JSON files on this server (survives restarts)" : <span className="text-sev-medium">In memory only (the data directory is not writable)</span> },
              { label: "Live scanning", value: data.liveScans.enabled ? (data.liveScans.allowedHosts ? <>Restricted to <Mono>{data.liveScans.allowedHosts.join(", ")}</Mono></> : "Enabled for public http(s) sites") : <span className="text-sev-medium">Disabled on this deployment (SITE_SENTRY_LIVE_SCANS=disabled)</span> },
              { label: "Safety", value: "Private, loopback, link-local and metadata addresses are refused, including after DNS resolution and on every redirect. 10 s timeout, 2 MB page cap, robots.txt respected." },
              { label: "Limits", value: "Up to 100 pages and 3 link levels per audit, 60 extra link status checks, 4 parallel requests." },
            ]}
          />
          {readOnly ? <p className="mt-4 text-[13px] text-fg-3">Editing rules happens in <Link href="/live/settings" className="text-accent-ink hover:underline">your workspace&apos;s settings</Link>.</p> : null}
        </Panel>
      </div>

      {!readOnly && dirty ? (
        <div className="sticky bottom-4 z-20 mt-6 flex items-center justify-between gap-3 rounded-lg bg-elevated px-4 py-3 shadow-pop">
          <span className="text-sm text-fg">Unsaved changes</span>
          <span className="flex gap-2">
            <Button variant="ghost" onClick={() => { setThin(null); setH1(null); setOverrides(null); }}>Discard</Button>
            <Button variant="primary" icon={Save} loading={saving} onClick={save}>Save settings</Button>
          </span>
        </div>
      ) : null}

      <ConfirmDialog open={confirmReset} onClose={() => setConfirmReset(false)} onConfirm={() => setSim({ reset: true })} busy={simBusy} danger title="Reset the sample workspace?" confirmLabel="Reset sample" description="Audits and tasks you created in the sample are discarded and the original seed is restored. Your own sites are not affected." />
    </>
  );
}
