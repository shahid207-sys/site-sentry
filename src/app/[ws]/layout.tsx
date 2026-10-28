import { AppShell } from "@/components/shell/AppShell";

export function generateStaticParams() {
  return [{ ws: "live" }, { ws: "sample" }];
}

export default function WorkspaceLayout({ children, params }: LayoutProps<"/[ws]">) {
  // The params promise is resolved inside the shell's Suspense boundary, so the frame prerenders.
  return <AppShell params={params}>{children}</AppShell>;
}
