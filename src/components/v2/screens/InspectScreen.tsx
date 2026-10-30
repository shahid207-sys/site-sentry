"use client";
// Page inspector (SPEC screen 7, "the evidence for one URL"): everything the audit stored for one URL, one tab per
// slice. The URL and the tab are in the query string (?url=…&tab=…), so every view is linkable and back-button safe.
// URLs the crawler did not read as a page (redirects, blocked, not fetched) show their crawl facts and the reason in
// plain words. PageSummary is the compact form the URL explorer's drawer shows.
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";
import { ExternalLink, FileSearch, SearchX, Table2 } from "lucide-react";
import { useMemo, type FormEvent } from "react";
import type { IssueState } from "@/lib/db/schema";
import type { PageDetail } from "@/lib/results/explore";
import { useApi } from "../../lib/api";
import { plural } from "../../lib/format";
import { Button, DefList, EmptyState, ErrorState, ExternalUrl, Input, LinkButton, Mono, Notice, Panel, Skeleton, Tag, cx } from "../../ui";
import { AuditFrame, useAudit } from "../AuditFrame";
import { IssueStateBadge, urlStateLabel } from "../badges";
import { ruleTitle, useQueryState } from "../hooks";
import { readSnapshot, stateWords } from "./inspect/snapshot";
import { CopyButton, HeadTagsTab, HeadersTab, HeadingsTab, ImagesTab, IssuesTab, LinksTab, OverviewTab, StructuredDataTab, inspectHref } from "./inspect/tabs";

// Its own chunk: most visits never open it.
const RenderedTab = dynamic(() => import("./inspect/rendered"), { loading: () => <Skeleton className="h-72 w-full rounded-2xl" /> });

const TABS = [
  { id: "overview", label: "Overview" },
  { id: "rendered", label: "Raw vs rendered" },
  { id: "headers", label: "Headers" },
  { id: "head", label: "Head tags" },
  { id: "headings", label: "Headings" },
  { id: "links", label: "Links in / out" },
  { id: "images", label: "Images" },
  { id: "structured-data", label: "Structured data" },
  { id: "issues", label: "Issue history" },
] as const;
type TabId = (typeof TABS)[number]["id"];

/** Copied from src/lib/results/states.ts (a server module): the issue states that count as open. */
const OPEN_STATES: IssueState[] = ["new", "persistent", "regressed", "not_rechecked"];

/** Crawl statuses after which the URL list no longer changes. */
const FINISHED = new Set(["completed", "cancelled", "failed"]);

/**
 * The "partial" state of the v2 screens: a crawl still running lists only the URLs found so far, and before analysis
 * runs, link metrics, templates and issue counts are empty (zero open issues then means "not analysed", not "clean").
 */
export function AuditDataNotice() {
  const { overview } = useAudit();
  if (!FINISHED.has(overview.status))
    return (
      <div className="mb-4">
        <Notice tone="info" title="This crawl is still in progress">
          The figures here cover only the URLs found and fetched so far. Reload when the crawl has finished.
        </Notice>
      </div>
    );
  if (!overview.analysed)
    return (
      <div className="mb-4">
        <Notice tone="warn" title="This audit has not been analysed yet">
          Inbound links, link depth, PageRank, templates and issue counts appear after analysis. Until then, zero open issues does not mean a page is clean.
        </Notice>
      </div>
    );
  return null;
}

const pageUrl = (auditApi: string, url: string) => `${auditApi}/page?url=${encodeURIComponent(url)}`;

export function InspectScreen() {
  const { auditId } = useParams<{ auditId: string }>();
  return (
    <AuditFrame auditId={auditId} title="Page inspector">
      <Inspector />
    </AuditFrame>
  );
}

function Inspector() {
  const { auditApi, auditBase, overview } = useAudit();
  const { get, params } = useQueryState();
  const pathname = usePathname();
  const url = get("url");
  const rawTab = get("tab");
  const tab: TabId = TABS.some((t) => t.id === rawTab) ? (rawTab as TabId) : "overview";
  const page = useApi<PageDetail>(url ? pageUrl(auditApi, url) : null);
  const snapshot = useMemo(() => readSnapshot(page.data?.snapshot ?? null), [page.data]);

  if (!url) return <PickUrl />;
  if (page.error) return page.error.status === 404 ? <NotInAudit url={url} /> : <ErrorState error={page.error} onRetry={page.reload} />;
  if (!page.data) return <InspectorSkeleton />;
  const d = page.data;
  const r = d.url;
  const open = d.issues.filter((i) => OPEN_STATES.includes(i.state)).length;

  const tabHref = (t: TabId) => {
    const p = new URLSearchParams(params.toString());
    if (t === "overview") p.delete("tab");
    else p.set("tab", t);
    return `${pathname}?${p}`;
  };

  return (
    <>
      <AuditDataNotice />
      <section aria-label="Inspected URL" className="mb-5 rounded-2xl border border-line bg-surface p-4 shadow-card sm:p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <h2 className="min-w-0 font-mono text-[14px] font-medium text-fg evidence">{r.url}</h2>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <CopyButton text={r.url} label="Copy URL" what="URL copied" />
            <ExternalUrl url={r.url} className="h-8 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg-2">
              Open live page
            </ExternalUrl>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px] text-fg-2">
          <Tag>{urlStateLabel(r.state)}</Tag>
          <span>HTTP {r.status ?? "—"}</span>
          {r.contentType ? <span className="text-fg-3">· {r.contentType}</span> : null}
          {r.noindex ? <Tag>noindex</Tag> : null}
          <span className="text-fg-3">·</span>
          <Link href={tabHref("issues")} className="hover:text-fg hover:underline">
            {plural(open, "open issue")}
          </Link>
          <span className="ml-auto">
            <Link href={`${auditBase}/urls`} className="inline-flex items-center gap-1 text-fg-2 hover:text-fg hover:underline">
              <Table2 className="size-3.5" aria-hidden />
              URL explorer
            </Link>
          </span>
        </div>
      </section>

      <nav className="mb-5 flex gap-1 overflow-x-auto rounded-xl border border-line bg-surface p-1 shadow-card" aria-label="Inspector sections">
        {TABS.map((t) => (
          <Link
            key={t.id}
            href={tabHref(t.id)}
            scroll={false}
            aria-current={tab === t.id ? "page" : undefined}
            className={cx(
              "flex h-9 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-sm transition-colors",
              tab === t.id ? "bg-sidebar-active font-semibold text-accent-ink" : "font-medium text-fg-2 hover:bg-hover hover:text-fg",
            )}
          >
            {t.label}
            {t.id === "issues" && d.issues.length ? <span className="ml-1.5 text-xs tabular text-fg-3">{d.issues.length}</span> : null}
            {t.id === "links" ? <span className="ml-1.5 text-xs tabular text-fg-3">{d.linksInTotal + d.linksOutTotal}</span> : null}
          </Link>
        ))}
      </nav>

      <div>
        {tab === "overview" ? (
          <OverviewTab d={d} s={snapshot} auditBase={auditBase} />
        ) : tab === "rendered" ? (
          <RenderedTab auditApi={auditApi} url={r.url} />
        ) : tab === "headers" ? (
          <HeadersTab s={snapshot} row={r} />
        ) : tab === "head" ? (
          <HeadTagsTab s={snapshot} row={r} />
        ) : tab === "headings" ? (
          <HeadingsTab s={snapshot} row={r} />
        ) : tab === "links" ? (
          <LinksTab d={d} auditBase={auditBase} />
        ) : tab === "images" ? (
          <ImagesTab s={snapshot} row={r} />
        ) : tab === "structured-data" ? (
          <StructuredDataTab s={snapshot} row={r} />
        ) : (
          <IssuesTab issues={d.issues} crawlId={overview.crawlId} />
        )}
      </div>
    </>
  );
}

/** No ?url= yet: say how to pick one, and accept a pasted URL. */
function PickUrl() {
  const { auditBase } = useAudit();
  const { set } = useQueryState();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = String(new FormData(e.currentTarget).get("url") ?? "").trim();
    if (v) set({ url: v, tab: null }, { push: true });
  };
  return (
    <Panel>
      <EmptyState icon={FileSearch} title="Pick a URL to inspect" action={<LinkButton href={`${auditBase}/urls`} icon={Table2}>Open the URL explorer</LinkButton>}>
        Open any row of the URL explorer, or paste a URL of this audit exactly as the crawler recorded it.
      </EmptyState>
      <form onSubmit={submit} className="mx-auto flex max-w-xl flex-col gap-2 pb-4 sm:flex-row sm:items-end">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <label htmlFor="inspect-url" className="text-[13px] font-medium text-fg">
            URL
          </label>
          <Input id="inspect-url" name="url" type="url" inputMode="url" placeholder="https://example.com/page" required className="font-mono text-[13px]" />
        </div>
        <Button type="submit" variant="primary">
          Inspect
        </Button>
      </form>
    </Panel>
  );
}

/** A 404 from the page route: the URL is not in this audit. Not an error, just a fact. */
function NotInAudit({ url }: { url: string }) {
  const { auditBase } = useAudit();
  return (
    <Panel>
      <EmptyState icon={SearchX} title="This audit has no such URL" action={<LinkButton href={`${auditBase}/urls`} icon={Table2}>Open the URL explorer</LinkButton>}>
        <Mono className="evidence block text-fg">{url}</Mono>
        <span className="mt-1.5 block">The crawler never recorded it in this audit, or recorded it in a different form (for example with or without a trailing slash).</span>
      </EmptyState>
    </Panel>
  );
}

function InspectorSkeleton() {
  return (
    <div role="status" aria-label="Loading the page">
      <Skeleton className="mb-5 h-[104px] w-full rounded-2xl" />
      <Skeleton className="mb-5 h-11 w-full rounded-xl" />
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <Skeleton key={i} className="h-56 rounded-2xl" />
        ))}
      </div>
      <span className="sr-only">Loading…</span>
    </div>
  );
}

/**
 * One URL in brief for the URL explorer's drawer: its key facts, its open issues, and a link to the full
 * inspector. Must render inside AuditFrame.
 */
export function PageSummary({ url }: { url: string }) {
  const { auditApi, auditBase } = useAudit();
  const page = useApi<PageDetail>(pageUrl(auditApi, url));

  if (page.error)
    return page.error.status === 404 ? (
      <Notice tone="info" title="This audit has no such URL">
        <Mono className="evidence">{url}</Mono>
      </Notice>
    ) : (
      <ErrorState error={page.error} onRetry={page.reload} />
    );
  if (!page.data)
    return (
      <div role="status" aria-label="Loading the page" className="space-y-3">
        {Array.from({ length: 8 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full" />
        ))}
        <span className="sr-only">Loading…</span>
      </div>
    );

  const d = page.data;
  const r = d.url;
  const open = d.issues.filter((i) => OPEN_STATES.includes(i.state));
  const s = readSnapshot(d.snapshot);
  // Read = an HTML body was extracted; a PDF or an error response has a snapshot but no page fields.
  const read = s?.extracted ?? false;
  return (
    <div className="space-y-5">
      <div>
        <p className="font-mono text-[13px] text-fg evidence">{r.url}</p>
        <div className="mt-3 flex flex-wrap gap-2">
          <LinkButton href={inspectHref(auditBase, r.url)} variant="primary" size="sm" icon={FileSearch}>
            Open full inspector
          </LinkButton>
          <ExternalUrl url={r.url} className="h-8 rounded-lg border border-line bg-surface px-2.5 text-[13px] text-fg-2">
            Open live page
          </ExternalUrl>
        </div>
      </div>

      {!s ? (
        <Notice tone="info" title={`${urlStateLabel(r.state)}: not read as a page`}>
          {stateWords(r.state)}
          {r.reason ? <Mono className="evidence mt-1 block text-fg">{r.reason}</Mono> : null}
        </Notice>
      ) : !read ? (
        <Notice tone="info" title="No HTML body was extracted">
          The response (HTTP {s.statusCode ?? "—"}, {s.contentType || "no content type"}) had no HTML body to read, so it has no title, headings or noindex to show.
        </Notice>
      ) : null}

      <DefList
        items={[
          { label: "State", value: <>{urlStateLabel(r.state)}{read && r.reason ? <Mono className="evidence mt-0.5 block text-fg-3">{r.reason}</Mono> : null}</> },
          { label: "HTTP status", value: <span className="tabular">{r.status ?? "—"}</span> },
          ...(r.redirectTarget ? [{ label: "Redirects to", value: <Mono className="evidence">{r.redirectTarget}</Mono> }] : []),
          ...(read
            ? [
                { label: "Title", value: r.title ?? <span className="text-fg-3">None</span> },
                { label: "Description", value: r.description ?? <span className="text-fg-3">None</span> },
                { label: "H1", value: r.h1 ?? <span className="text-fg-3">None</span> },
                { label: "Words", value: <span className="tabular">{r.wordCount?.toLocaleString("en-GB") ?? "—"}</span> },
                { label: "Canonical", value: r.canonical ? <Mono className="evidence">{r.canonical}</Mono> : <span className="text-fg-3">None</span> },
                { label: "noindex", value: r.noindex ? "Yes" : "No" },
              ]
            : []),
          { label: "Click depth", value: r.depth === null ? "Not linked from the start URL" : <span className="tabular">{r.depth}</span> },
          { label: "Inbound links", value: <span className="tabular">{r.inbound?.toLocaleString("en-GB") ?? "—"}</span> },
          { label: "Links", value: `${plural(d.linksInTotal, "link")} in · ${plural(d.linksOutTotal, "link")} out` },
        ]}
      />

      <section aria-labelledby="summary-issues">
        <h3 id="summary-issues" className="mb-2 text-sm font-semibold text-fg">
          Open issues ({open.length})
        </h3>
        {open.length === 0 ? (
          <p className="text-[13px] text-fg-3">{d.issues.length ? `No open issues (${plural(d.issues.length, "finding")} resolved or inconclusive).` : "No findings on this URL."}</p>
        ) : (
          <ul className="divide-y divide-line-subtle rounded-lg border border-line-subtle">
            {open.slice(0, 12).map((i) => (
              <li key={i.fingerprint} className="flex flex-col gap-1 px-3 py-2.5">
                <div className="flex items-start justify-between gap-2">
                  <span className="min-w-0 text-[13px] font-medium text-fg">{ruleTitle(i.ruleId)}</span>
                  <IssueStateBadge state={i.state} />
                </div>
                {i.message ? <p className="evidence line-clamp-3 text-xs text-fg-2">{i.message}</p> : null}
              </li>
            ))}
          </ul>
        )}
        {open.length > 12 ? (
          <Link href={inspectHref(auditBase, r.url, "issues")} className="mt-2 inline-flex items-center gap-1 text-[13px] text-accent-ink hover:underline">
            <ExternalLink className="size-3.5" aria-hidden />
            All {open.length} in the inspector
          </Link>
        ) : null}
      </section>
    </div>
  );
}
