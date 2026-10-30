"use client";
// Frame of every v2 audit screen: the audit's header and section tabs, with its overview shared through context so
// screens do not fetch it again. Sections are routes under /[ws]/audits/[auditId]/…, so each is linkable and
// back-button safe; filters live in each screen's query string.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { FileText, RefreshCw } from "lucide-react";
import { createContext, useContext, type ReactNode } from "react";
import type { CrawlOverview } from "@/lib/results/queries";
import { useApi, type Resource } from "../lib/api";
import { fmtDateTime, hostOf } from "../lib/format";
import { useWs } from "../shell/context";
import { ErrorState, LinkButton, PageHeader, PageSkeleton, Tag, cx } from "../ui";

export const AUDIT_SECTIONS = [
  { id: "overview", label: "Overview", path: "" },
  { id: "issues", label: "Issues", path: "/issues" },
  { id: "urls", label: "URLs", path: "/urls" },
  { id: "architecture", label: "Architecture", path: "/architecture" },
  { id: "content", label: "Content", path: "/content" },
  { id: "board", label: "Fix board", path: "/board" },
  { id: "compare", label: "Compare", path: "/compare" },
] as const;
export type AuditSection = (typeof AUDIT_SECTIONS)[number]["id"] | "inspect";

interface AuditCtx {
  auditId: string;
  /** "/live/audits/<id>" */
  auditBase: string;
  /** "/api/live/audits/<id>" */
  auditApi: string;
  overview: CrawlOverview;
  reload: () => void;
}

const Ctx = createContext<AuditCtx | null>(null);

/** The audit of the current v2 screen (inside AuditFrame). */
export function useAudit(): AuditCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useAudit outside AuditFrame");
  return c;
}

/** The section a pathname belongs to. */
function sectionOf(pathname: string, auditBase: string): AuditSection {
  const rest = pathname.slice(auditBase.length);
  if (rest.startsWith("/inspect")) return "inspect";
  return AUDIT_SECTIONS.find((s) => s.path && rest.startsWith(s.path))?.id ?? "overview";
}

export function AuditFrame({ auditId, title, children, actions }: { auditId: string; title?: string; children: ReactNode; actions?: ReactNode }) {
  const { base, apiBase, sites } = useWs();
  const pathname = usePathname();
  const auditBase = `${base}/audits/${auditId}`;
  const auditApi = `${apiBase}/audits/${auditId}`;
  const ov: Resource<CrawlOverview> = useApi<CrawlOverview>(`${auditApi}/overview`);
  const section = sectionOf(pathname, auditBase);
  const site = ov.data ? sites.data?.find((s) => s.site.id === ov.data!.project)?.site : undefined;
  const name = site?.name ?? (ov.data ? hostOf(ov.data.siteOrigin) : "Audit");
  const crumbs = [{ label: "Audits", href: `${base}/audits` }, { label: name, href: section === "overview" ? undefined : auditBase }];

  if (ov.error) return (<><PageHeader title="Audit" crumbs={crumbs} /><ErrorState error={ov.error} onRetry={ov.reload} /></>);
  if (!ov.data) return <PageSkeleton />;
  const o = ov.data;

  return (
    <Ctx.Provider value={{ auditId, auditBase, auditApi, overview: o, reload: ov.reload }}>
      <PageHeader
        crumbs={crumbs}
        title={title ?? name}
        meta={
          <>
            <Tag>{o.profile}</Tag>
            <span className="text-[13px] text-fg-3">
              Audit of {hostOf(o.siteOrigin)} · {fmtDateTime(o.createdAt)}
            </span>
          </>
        }
        actions={
          actions ?? (
            <>
              <LinkButton href={`${base}/reports/${auditId}`} icon={FileText}>Report</LinkButton>
              <LinkButton href={`${base}/audits/new?site=${encodeURIComponent(o.project)}`} icon={RefreshCw} variant="primary">Re-run</LinkButton>
            </>
          )
        }
      />
      <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-line-subtle" aria-label="Audit sections">
        {AUDIT_SECTIONS.map((s) => (
          <Link
            key={s.id}
            href={`${auditBase}${s.path}`}
            aria-current={section === s.id ? "page" : undefined}
            className={cx("-mb-px shrink-0 border-b-2 px-3 pb-2.5 pt-1 text-sm transition-colors", section === s.id ? "border-accent font-medium text-fg" : "border-transparent text-fg-2 hover:text-fg")}
          >
            {s.label}
          </Link>
        ))}
      </nav>
      {children}
    </Ctx.Provider>
  );
}
