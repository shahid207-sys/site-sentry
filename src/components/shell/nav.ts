import { CircleAlert, FileText, Globe, LayoutDashboard, ListChecks, ScanSearch, Settings, type LucideIcon } from "lucide-react";

export const NAV: { href: string; label: string; icon: LucideIcon; match: (p: string) => boolean }[] = [
  { href: "", label: "Overview", icon: LayoutDashboard, match: (p) => p === "" },
  { href: "/sites", label: "Sites", icon: Globe, match: (p) => p.startsWith("/sites") },
  { href: "/audits", label: "Audits", icon: ScanSearch, match: (p) => p.startsWith("/audits") },
  { href: "/issues", label: "Issues", icon: CircleAlert, match: (p) => p.startsWith("/issues") },
  { href: "/tasks", label: "Fix Queue", icon: ListChecks, match: (p) => p.startsWith("/tasks") },
  { href: "/reports", label: "Reports", icon: FileText, match: (p) => p.startsWith("/reports") },
  { href: "/settings", label: "Settings", icon: Settings, match: (p) => p.startsWith("/settings") },
];
