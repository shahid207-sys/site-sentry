"use client";
// Scheduled audits of one site (site page): list, create, pause/resume, run now, delete, and each schedule's recent
// regression alerts. A webhook's signing secret is shown once, right after the schedule is created.
import { useState, type FormEvent } from "react";
import { BellRing, CalendarClock, Copy, Pause, Play, Plus, Trash2, Zap } from "lucide-react";
import { RULE_CATEGORIES } from "@/lib/audit/types";
import { PROFILES } from "@/lib/crawl/profiles";
import { CADENCES, describeTiming, type Cadence } from "@/lib/schedule/cadence";
import type { Delivery, Schedule } from "@/lib/schedule/store";
import type { Site } from "@/lib/model";
import { api, ApiError, useApi } from "../lib/api";
import { fmtAgo, fmtDateTime } from "../lib/format";
import { ConfirmDialog, Modal, useToast } from "../overlays";
import { useWs } from "../shell/context";
import { Button, EmptyState, ErrorState, Field, Input, Notice, Panel, Select, Tag } from "../ui";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const PROFILE_CHOICES = (["quick", "standard", "full"] as const).map((id) => PROFILES[id]);

type Request = { profile?: string; checkLinks?: boolean };

export function ScheduledAudits({ site }: { site: Site }) {
  const { apiBase } = useWs();
  const toast = useToast();
  const res = useApi<Schedule[]>(`${apiBase}/schedules?site=${encodeURIComponent(site.id)}`);
  const [creating, setCreating] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Schedule | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const act = async (s: Schedule, body: { enabled?: boolean; runNow?: true }, done: string) => {
    setBusy(s.id);
    try {
      await api(`${apiBase}/schedules/${s.id}`, { method: "PATCH", body });
      toast({ tone: "ok", title: done });
      await res.reload();
    } catch (e) {
      toast({ tone: "error", title: "Could not update the schedule", detail: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setBusy(removing.id);
    try {
      await api(`${apiBase}/schedules/${removing.id}`, { method: "DELETE" });
      toast({ tone: "ok", title: "Schedule deleted" });
      setRemoving(null);
      await res.reload();
    } catch (e) {
      toast({ tone: "error", title: "Could not delete the schedule", detail: (e as Error).message });
    } finally {
      setBusy(null);
    }
  };

  const list = res.data ?? [];
  return (
    <Panel
      className="mt-6"
      title="Scheduled audits"
      description="Re-audit this site on a timetable (UTC). When a run finds new or regressed issue groups compared with the previous audit, its webhook gets a signed alert."
      actions={<Button size="sm" icon={Plus} onClick={() => setCreating(true)}>Schedule</Button>}
      flush
    >
      {secret ? (
        <div className="p-4">
          <Notice tone="warn" title="Copy the webhook signing secret now" action={<Button size="sm" variant="ghost" onClick={() => setSecret(null)}>Done</Button>}>
            It is shown only once. Each alert carries <code className="font-mono">x-sitesentry-signature: sha256=&lt;HMAC-SHA256 of the body&gt;</code>.
            <span className="mt-2 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-xs" data-testid="webhook-secret">{secret}</code>
              <Button size="sm" variant="ghost" icon={Copy} onClick={() => void navigator.clipboard?.writeText(secret)}>Copy</Button>
            </span>
          </Notice>
        </div>
      ) : null}
      {res.error ? (
        <div className="p-4"><ErrorState error={res.error} onRetry={res.reload} /></div>
      ) : res.loading && !res.data ? (
        <p className="p-4 text-sm text-fg-3" role="status">Loading schedules…</p>
      ) : list.length ? (
        <ul className="divide-y divide-line-subtle" aria-label="Schedules">
          {list.map((s) => {
            const req = s.request as Request;
            return (
              <li key={s.id} className="px-4 py-3">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <CalendarClock className="size-4 shrink-0 text-fg-3" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-fg">{describeTiming(s)}</span>
                    <span className="block text-xs text-fg-3">
                      {PROFILES[req.profile as keyof typeof PROFILES]?.label ?? req.profile} profile
                      {s.enabled ? ` · next ${fmtDateTime(s.nextRunAt)}` : " · paused"}
                      {s.lastRun ? ` · last run ${fmtAgo(s.lastRun.startedAt)}${s.lastRun.error ? ` (failed: ${s.lastRun.error})` : ""}` : ""}
                    </span>
                  </span>
                  {s.webhookUrl ? <Tag>Webhook: {new URL(s.webhookUrl).host}</Tag> : <Tag>No webhook</Tag>}
                  <span className="flex gap-1">
                    <Button size="sm" variant="ghost" icon={Zap} disabled={busy === s.id} onClick={() => void act(s, { runNow: true }, "Runs at the next scheduler tick (within a minute)")}>Run now</Button>
                    {s.enabled ? (
                      <Button size="sm" variant="ghost" icon={Pause} disabled={busy === s.id} onClick={() => void act(s, { enabled: false }, "Schedule paused")}>Pause</Button>
                    ) : (
                      <Button size="sm" variant="ghost" icon={Play} disabled={busy === s.id} onClick={() => void act(s, { enabled: true }, "Schedule resumed")}>Resume</Button>
                    )}
                    <Button size="sm" variant="ghost" icon={BellRing} aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>Alerts</Button>
                    <Button size="sm" variant="ghost" icon={Trash2} aria-label={`Delete schedule: ${describeTiming(s)}`} disabled={busy === s.id} onClick={() => setRemoving(s)} />
                  </span>
                </div>
                {open === s.id ? <Deliveries scheduleId={s.id} /> : null}
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState compact icon={CalendarClock} title="No scheduled audits">Schedule a daily, weekly or monthly audit to catch regressions.</EmptyState>
      )}
      {creating ? (
        <CreateScheduleModal
          site={site}
          onClose={() => setCreating(false)}
          onCreated={(webhookSecret) => {
            setCreating(false);
            setSecret(webhookSecret);
            void res.reload();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={!!removing}
        onClose={() => setRemoving(null)}
        onConfirm={() => void remove()}
        busy={!!removing && busy === removing.id}
        danger
        title="Delete this schedule?"
        confirmLabel="Delete schedule"
        description="Audits it already ran stay; its alert history goes with it."
      />
    </Panel>
  );
}

function Deliveries({ scheduleId }: { scheduleId: string }) {
  const { apiBase, base } = useWs();
  const res = useApi<Delivery[]>(`${apiBase}/schedules/${scheduleId}/deliveries`);
  if (res.error) return <ErrorState error={res.error} onRetry={res.reload} />;
  if (!res.data) return <p className="mt-2 text-xs text-fg-3" role="status">Loading alerts…</p>;
  if (!res.data.length) return <p className="mt-2 text-xs text-fg-3">No analysed scheduled audit yet.</p>;
  return (
    <ul className="mt-2 space-y-1 text-xs" aria-label="Alert history">
      {res.data.map((d) => (
        <li key={d.id} className="flex flex-wrap gap-x-2 text-fg-2">
          <span className="text-fg-3">{fmtDateTime(d.createdAt)}</span>
          <span className={d.status === "failed" ? "font-medium text-sev-high" : d.status === "sent" ? "font-medium text-fg" : ""}>{d.status === "sent" ? "Alert sent" : d.status === "failed" ? "Alert failed" : "No alert"}</span>
          <span>{d.detail}</span>
          {d.auditId ? <a className="text-accent-ink underline" href={`${base}/audits/${d.auditId}/compare`}>Compare</a> : null}
        </li>
      ))}
    </ul>
  );
}

function CreateScheduleModal({ site, onClose, onCreated }: { site: Site; onClose: () => void; onCreated: (webhookSecret: string | null) => void }) {
  const { apiBase } = useWs();
  const [cadence, setCadence] = useState<Cadence>("weekly");
  const [hour, setHour] = useState(6);
  const [weekday, setWeekday] = useState(1);
  const [monthday, setMonthday] = useState(1);
  const [profile, setProfile] = useState<(typeof PROFILE_CHOICES)[number]["id"]>("standard");
  const [checkLinks, setCheckLinks] = useState(false);
  const [webhookUrl, setWebhookUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ webhookSecret: string | null }>(`${apiBase}/schedules`, {
        method: "POST",
        body: {
          siteId: site.id,
          cadence,
          hourUtc: hour,
          weekday: cadence === "weekly" ? weekday : null,
          monthday: cadence === "monthly" ? monthday : null,
          request: { mode: "sitemap", urls: [], sitemapUrl: site.sitemapUrl ?? undefined, profile, categories: RULE_CATEGORIES.map((c) => c.id), checkLinks, includeImportant: true },
          webhookUrl: webhookUrl.trim() || null,
        },
      });
      onCreated(r.webhookSecret);
    } catch (err) {
      setError((err as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title="Schedule an audit"
      description={`Re-audits ${site.name} from its home page and sitemap. Times are UTC.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="schedule-form" loading={busy}>Save schedule</Button>
        </>
      }
    >
      <form id="schedule-form" onSubmit={(e) => void submit(e)} className="space-y-4" noValidate>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Repeat" htmlFor="sch-cadence">
            <Select id="sch-cadence" value={cadence} onChange={(e) => setCadence(e.target.value as Cadence)}>
              {CADENCES.map((c) => <option key={c} value={c}>{c[0].toUpperCase() + c.slice(1)}</option>)}
            </Select>
          </Field>
          {cadence === "weekly" ? (
            <Field label="Day" htmlFor="sch-weekday">
              <Select id="sch-weekday" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                {WEEKDAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}
              </Select>
            </Field>
          ) : cadence === "monthly" ? (
            <Field label="Day of the month" hint="1–28, so every month has it." htmlFor="sch-monthday">
              <Select id="sch-monthday" value={monthday} onChange={(e) => setMonthday(Number(e.target.value))}>
                {Array.from({ length: 28 }, (_, i) => <option key={i} value={i + 1}>{i + 1}</option>)}
              </Select>
            </Field>
          ) : null}
          <Field label="Hour (UTC)" htmlFor="sch-hour">
            <Select id="sch-hour" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </Select>
          </Field>
          <Field label="Crawl profile" htmlFor="sch-profile">
            <Select id="sch-profile" value={profile} onChange={(e) => setProfile(e.target.value as typeof profile)}>
              {PROFILE_CHOICES.map((p) => <option key={p.id} value={p.id}>{p.label} (up to {p.budget.toLocaleString("en")} URLs)</option>)}
            </Select>
          </Field>
        </div>
        <label className="flex items-center gap-2 text-sm text-fg">
          <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={checkLinks} onChange={(e) => setCheckLinks(e.target.checked)} />
          Check outgoing links
        </label>
        <Field label="Webhook URL (optional)" hint="Receives a signed JSON alert when a run finds new or regressed issue groups. Private and internal addresses are refused." htmlFor="sch-hook" error={error}>
          <Input id="sch-hook" type="url" inputMode="url" placeholder="https://hooks.example.com/sitesentry" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} />
        </Field>
      </form>
    </Modal>
  );
}
