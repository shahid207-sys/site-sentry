"use client";
import { createContext, useContext, type ReactNode } from "react";
import type { Workspace } from "@/lib/model";
import type { SiteRow } from "@/lib/views";
import { useApi, type Resource } from "../lib/api";

interface WsCtx {
  ws: Workspace;
  /** "/live" or "/sample" */
  base: string;
  /** "/api/live" or "/api/sample" */
  apiBase: string;
  sites: Resource<SiteRow[]>;
}

const Ctx = createContext<WsCtx | null>(null);

export function useWs(): WsCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWs outside WorkspaceProvider");
  return c;
}

/** For primitives that may render outside a workspace (e.g. error boundaries). */
export function useWsOptional(): WsCtx | null {
  return useContext(Ctx);
}

export function WorkspaceProvider({ ws, children }: { ws: Workspace; children: ReactNode }) {
  const sites = useApi<SiteRow[]>(`/api/${ws}/sites`);
  return <Ctx.Provider value={{ ws, base: `/${ws}`, apiBase: `/api/${ws}`, sites }}>{children}</Ctx.Provider>;
}
