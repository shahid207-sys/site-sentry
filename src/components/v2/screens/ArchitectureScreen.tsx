"use client";
// Site architecture (SPEC screen 8, "see structure problems"): the crawl-depth histogram (/structure), a breakdown of
// URLs, issues, words and inbound links per first-level folder (computed from /urls), the internal PageRank
// leaderboard and the pages that are deep or unreachable by links. Every figure comes from the API; the directory
// table sort is in the query string. The interactive link graph is not built (docs/PHASE4.md conflict #3).
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowRight, FolderTree, Network } from "lucide-react";
import { useMemo } from "react";
import type { UrlRow } from "@/lib/results/explore";
import type { AuditStructure } from "@/lib/server/results";
import { useApi, type Resource } from "../../lib/api";
import { hostOf, plural, shortUrl } from "../../lib/format";
import { EmptyState, ErrorState, LinkButton, Panel, Skeleton, StatStrip } from "../../ui";
import { AuditFrame, useAudit } from "../AuditFrame";
import { useQueryState } from "../hooks";
import { inspectHref } from "../links";
import { DensityToggle, VirtualTable, formatSort, parseSort, sortRows, type Column } from "../VirtualTable";
import { Histogram } from "./architecture/Histogram";
import { MAX_CLICK_DEPTH, depthBars, depthProblems, directoryBreakdown, directorySortKey, pagerankLeaders, type DepthBar, type DepthProblems, type DirectoryRow } from "./architecture/model";
import { AuditDataNotice } from "./InspectScreen";

const NO_ROWS: UrlRow[] = [];
const dash = <span className="text-fg-3">—</span>;
const fmt1 = (n: number | null) => (n === null ? dash : n.toLocaleString("en-GB", { maximumFractionDigits: 1 }));

export function ArchitectureScreen() {
  const { auditId } = useParams<{ auditId: string }>();
  return (
    <AuditFrame auditId={auditId}>
      <Architecture />
    </AuditFrame>
  );
}

function Architecture() {
  const { auditApi, overview } = useAudit();
  const structure = useApi<AuditStructure>(`${auditApi}/structure`);
  const urls = useApi<UrlRow[]>(`${auditApi}/urls`);
  const all = urls.data ?? NO_ROWS;
  const siteHost = hostOf(overview.siteOrigin);
  const bars = useMemo(() => depthBars(structure.data?.depth ?? []), [structure.data]);
  const dirs = useMemo(() => directoryBreakdown(all, siteHost), [all, siteHost]);
  const problems = useMemo(() => depthProblems(all), [all]);
  const leaders = useMemo(() => pagerankLeaders(all, 50), [all]);

  const linked = bars.filter((b) => b.depth !== null);
  const sitemapOnly = bars.find((b) => b.depth === null)?.urls ?? 0;

  return (
    <div className="flex flex-col gap-6">
      <AuditDataNotice />
      <StatStrip
        items={[
          { label: "URLs found", value: structure.data ? bars.reduce((n, b) => n + b.urls, 0).toLocaleString("en-GB") : "—", hint: "Every URL of the crawl, on any host" },
          { label: "Deepest link depth", value: linked.length ? String(linked[linked.length - 1].depth) : "—", hint: "Fewest clicks from a start URL to the deepest URL" },
          { label: "Only in sitemaps", value: structure.data ? sitemapOnly.toLocaleString("en-GB") : "—", hint: "Found in a sitemap, never by a link from a start URL" },
          { label: "Folders", value: urls.data ? dirs.rows.length.toLocaleString("en-GB") : "—", hint: `First-level folders of ${siteHost}` },
        ]}
      />
      <DepthPanel structure={structure} bars={bars} />
      <DirectoryPanel loading={!urls.data} error={urls.error} onRetry={urls.reload} rows={dirs.rows} otherHosts={dirs.otherHosts} siteHost={siteHost} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
        <LeaderPanel loading={!urls.data} error={urls.error} onRetry={urls.reload} leaders={leaders} siteHost={siteHost} />
        <DepthProblemsPanel loading={!urls.data} error={urls.error} onRetry={urls.reload} problems={problems} siteHost={siteHost} />
      </div>
    </div>
  );
}

const pathOf = (url: string, siteHost: string) => (hostOf(url) === siteHost ? shortUrl(url) : url);

function LoadingRows({ label, n = 5 }: { label: string; n?: number }) {
  return (
    <div className="flex flex-col gap-2" role="status" aria-label={label}>
      {Array.from({ length: n }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

// ---------- depth ----------

function DepthPanel({ structure, bars }: { structure: Resource<AuditStructure>; bars: DepthBar[] }) {
  return (
    <Panel title="Crawl depth" description="URLs per link depth from the start URLs, split by whether the server answered them">
      {structure.error ? (
        <ErrorState error={structure.error} onRetry={structure.reload} />
      ) : !structure.data ? (
        <Skeleton className="h-[200px] w-full" />
      ) : !bars.length ? (
        <EmptyState icon={Network} title="No URLs recorded yet" compact>
          The crawl has not recorded any URL, so there is no depth to show.
        </EmptyState>
      ) : (
        <Histogram
          title="URLs per crawl depth"
          xLabel="Link depth (clicks from a start URL)"
          unit="URLs"
          series={[
            { id: "answered", name: "Answered (page, redirect or file)", color: "var(--info)" },
            { id: "notAnswered", name: "Not answered (excluded, failed or not fetched)", color: "var(--fg-3)" },
          ]}
          bars={bars.map((b) => ({
            key: b.depth === null ? "sitemap" : String(b.depth),
            label: b.depth === null ? "Sitemap" : b.label,
            longLabel: b.depth === null ? "Only in sitemaps" : `Depth ${b.label}`,
            values: { answered: b.answered, notAnswered: b.notAnswered },
          }))}
        />
      )}
    </Panel>
  );
}

// ---------- folders ----------

function DirectoryPanel({ loading, error, onRetry, rows, otherHosts, siteHost }: { loading: boolean; error: Error | null; onRetry: () => void; rows: DirectoryRow[]; otherHosts: number; siteHost: string }) {
  const { auditBase } = useAudit();
  const router = useRouter();
  const { get, set } = useQueryState();
  const sortParam = get("sort");
  const sort = useMemo(() => parseSort(sortParam), [sortParam]);
  const sorted = useMemo(() => sortRows(rows, sort, directorySortKey), [rows, sort]);
  const maxDensity = useMemo(() => Math.max(0, ...rows.map((r) => r.issuesPerUrl)), [rows]);
  const href = (r: DirectoryRow) => `${auditBase}/urls?q=${encodeURIComponent(r.q)}`;
  const onSort = (id: string) => {
    const next = !sort || sort.id !== id ? { id, dir: "desc" as const } : sort.dir === "desc" ? { id, dir: "asc" as const } : null;
    set({ sort: formatSort(next) });
  };

  const columns: Column<DirectoryRow>[] = [
    {
      id: "dir",
      header: "Folder",
      width: "minmax(220px, 2fr)",
      sortable: true,
      cell: (r) => (
        <Link href={href(r)} className="font-mono text-[12.5px] text-fg hover:text-accent-ink hover:underline" title={r.exactFilter ? `Show the URLs in ${r.dir}` : `Show URLs containing ${siteHost}${r.dir} (approximate filter)`}>
          {r.dir === "/" ? "/ (root pages)" : r.dir}
        </Link>
      ),
    },
    { id: "urls", header: "URLs", width: "88px", align: "right", sortable: true, cell: (r) => r.urls.toLocaleString("en-GB") },
    { id: "answered", header: "Answered", width: "96px", align: "right", sortable: true, cell: (r) => r.answered.toLocaleString("en-GB") },
    { id: "openIssues", header: "Open issues", width: "108px", align: "right", sortable: true, cell: (r) => (r.openIssues ? <span className="font-medium text-fg">{r.openIssues.toLocaleString("en-GB")}</span> : <span className="text-fg-3">0</span>) },
    {
      id: "issuesPerUrl",
      header: "Issues per URL",
      width: "150px",
      align: "right",
      sortable: true,
      cell: (r) => (
        <span className="inline-flex items-center justify-end gap-2">
          <span className="h-1.5 w-12 overflow-hidden rounded-full bg-elevated" aria-hidden>
            <span className="block h-full rounded-full bg-accent" style={{ width: `${maxDensity ? (100 * r.issuesPerUrl) / maxDensity : 0}%` }} />
          </span>
          <span className="w-10">{r.issuesPerUrl.toLocaleString("en-GB", { maximumFractionDigits: 2 })}</span>
        </span>
      ),
    },
    { id: "avgWords", header: "Avg words", width: "100px", align: "right", sortable: true, cell: (r) => (r.avgWords === null ? dash : Math.round(r.avgWords).toLocaleString("en-GB")) },
    { id: "avgInbound", header: "Avg inbound links", width: "140px", align: "right", sortable: true, cell: (r) => fmt1(r.avgInbound) },
  ];

  return (
    <Panel
      flush
      title="Folders"
      description={`URLs of ${siteHost} by first-level folder. Pages directly under / are in the root row. Averages cover the URLs that have the value.`}
      actions={<DensityToggle />}
    >
      <div className="p-4">
        {error ? (
          <ErrorState error={error} onRetry={onRetry} />
        ) : loading ? (
          <LoadingRows label="Loading folders" n={8} />
        ) : (
          <>
            <VirtualTable
              rows={sorted}
              columns={columns}
              rowKey={(r) => r.dir}
              label="URLs, open issues, words and inbound links per folder"
              onOpen={(r) => router.push(href(r))}
              sort={sort}
              onSort={onSort}
              height="min(520px, calc(100dvh - 260px))"
              empty={
                <EmptyState compact icon={FolderTree} title={`No URL of ${siteHost} in this crawl`}>
                  {otherHosts ? `All ${plural(otherHosts, "URL")} recorded are on other hosts.` : "The crawl has not recorded any URL yet."}
                </EmptyState>
              }
            />
            <p className="mt-2 text-xs text-fg-3">
              Select a folder to see its URLs in the URL explorer.
              {otherHosts ? ` ${plural(otherHosts, "URL")} on other hosts (out of scope, or redirect targets elsewhere) are not in any folder.` : ""}
            </p>
          </>
        )}
      </div>
    </Panel>
  );
}

// ---------- PageRank ----------

function LeaderPanel({ loading, error, onRetry, leaders, siteHost }: { loading: boolean; error: Error | null; onRetry: () => void; leaders: UrlRow[]; siteHost: string }) {
  const { auditBase, overview } = useAudit();
  return (
    <Panel title="Internal PageRank" description="The 50 URLs internal links give the most weight. Scores run 0–100 on a log scale (20 iterations, damping 0.85)" flush>
      {error ? (
        <div className="p-4">
          <ErrorState error={error} onRetry={onRetry} />
        </div>
      ) : loading ? (
        <div className="p-4">
          <LoadingRows label="Loading the PageRank leaderboard" n={8} />
        </div>
      ) : !leaders.length ? (
        <EmptyState icon={Network} title="No PageRank yet" compact>
          {overview.analysed ? "The site pass gave no URL a PageRank score: no internal link between crawled pages was found." : "PageRank is computed by the analysis that runs after the crawl."}
        </EmptyState>
      ) : (
        <div className="max-h-[560px] overflow-auto">
          <table className="w-full text-[13px]">
            <caption className="sr-only">The 50 URLs with the highest internal PageRank, with inbound links and link depth</caption>
            <thead className="sticky top-0 z-10 bg-surface-secondary">
              <tr className="border-b border-line text-left text-xs text-fg-2">
                <th scope="col" className="w-10 px-3 py-2 text-right font-medium">#</th>
                <th scope="col" className="px-3 py-2 font-medium">URL</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">PageRank</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Inbound</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Link depth</th>
              </tr>
            </thead>
            <tbody>
              {leaders.map((r, i) => (
                <tr key={r.url} className="border-b border-line-subtle last:border-0 hover:bg-hover">
                  <td className="px-3 py-2 text-right tabular text-fg-3">{i + 1}</td>
                  <th scope="row" className="max-w-0 truncate px-3 py-2 text-left font-normal">
                    <Link href={inspectHref(auditBase, r.url)} title={r.url} className="font-mono text-[12.5px] text-fg hover:text-accent-ink hover:underline">
                      {pathOf(r.url, siteHost)}
                    </Link>
                  </th>
                  <td className="px-3 py-2 text-right tabular text-fg">{r.pagerank!.toLocaleString("en-GB", { maximumFractionDigits: 2 })}</td>
                  <td className="px-3 py-2 text-right tabular text-fg-2">{r.inbound === null ? dash : r.inbound.toLocaleString("en-GB")}</td>
                  <td className="px-3 py-2 text-right tabular text-fg-2">{r.linkDepth === null ? dash : r.linkDepth}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

// ---------- deep and unreachable pages ----------

const SHOW = 8;

function DepthProblemsPanel({ loading, error, onRetry, problems, siteHost }: { loading: boolean; error: Error | null; onRetry: () => void; problems: DepthProblems; siteHost: string }) {
  const { auditBase, overview } = useAudit();
  const body = () => {
    if (error) return <ErrorState error={error} onRetry={onRetry} />;
    if (loading) return <LoadingRows label="Loading deep pages" />;
    if (!overview.analysed)
      return (
        <EmptyState icon={Network} title="Link depth is not measured yet" compact>
          Clicks from the start page are measured by the analysis that runs after the crawl.
        </EmptyState>
      );
    if (!problems.pages)
      return (
        <EmptyState icon={Network} title="No HTML page was crawled" compact>
          Link depth describes HTML pages; this crawl read none.
        </EmptyState>
      );
    return (
      <div className="flex flex-col gap-5">
        <PageList
          title={`More than ${MAX_CLICK_DEPTH} clicks from the start page`}
          rows={problems.deep}
          total={problems.pages}
          detail={(r) => `${r.linkDepth} clicks`}
          rule="LNK-004"
          ruleText="Deep-page findings (LNK-004)"
          none="Every crawled HTML page is within reach."
          siteHost={siteHost}
          auditBase={auditBase}
        />
        <PageList
          title="No link path from the start page"
          rows={problems.unreachable}
          total={problems.pages}
          detail={(r) => (r.inbound ? `${plural(r.inbound, "inbound link")}` : "no inbound links")}
          rule="LNK-003"
          ruleText="Orphan candidates (LNK-003)"
          none="Every crawled HTML page can be reached by following links from the start page."
          siteHost={siteHost}
          auditBase={auditBase}
        />
        <p className="text-xs text-fg-3">
          Counts of crawled HTML pages by the site pass&apos;s click depth. The linked rules apply their own conditions (indexable pages; for orphans, listed in a sitemap with no inbound
          link), so their counts can be lower.
        </p>
      </div>
    );
  };
  return (
    <Panel title="Deep and unreachable pages" description="Pages search engines and visitors reach only with many clicks, or not by links at all">
      {body()}
    </Panel>
  );
}

function PageList({ title, rows, total, detail, rule, ruleText, none, siteHost: host, auditBase }: { title: string; rows: UrlRow[]; total: number; detail: (r: UrlRow) => string; rule: string; ruleText: string; none: string; siteHost: string; auditBase: string }) {
  return (
    <section aria-label={title}>
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-[13px] font-medium text-fg">{title}</h3>
        <span className="text-[13px] tabular text-fg">
          <span className="font-semibold">{rows.length.toLocaleString("en-GB")}</span>
          <span className="text-fg-3"> of {plural(total, "page")}</span>
        </span>
      </div>
      {rows.length ? (
        <>
          <ul className="divide-y divide-line-subtle rounded-lg border border-line">
            {rows.slice(0, SHOW).map((r) => (
              <li key={r.url} className="flex items-center justify-between gap-3 px-3 py-2 text-[13px]">
                <Link href={inspectHref(auditBase, r.url)} title={r.url} className="min-w-0 truncate font-mono text-[12.5px] text-fg hover:text-accent-ink hover:underline">
                  {pathOf(r.url, host)}
                </Link>
                <span className="shrink-0 tabular text-xs text-fg-2">{detail(r)}</span>
              </li>
            ))}
          </ul>
          {rows.length > SHOW ? <p className="mt-1.5 text-xs text-fg-3">Showing {SHOW} of {rows.length.toLocaleString("en-GB")}.</p> : null}
        </>
      ) : (
        <p className="text-[13px] text-fg-2">{none}</p>
      )}
      <div className="mt-2">
        <LinkButton href={`${auditBase}/issues?rule=${rule}&expand=${rule}`} size="sm" variant="ghost" icon={ArrowRight}>
          {ruleText}
        </LinkButton>
      </div>
    </section>
  );
}
