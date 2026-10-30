"use client";
// One rule's fingerprints with their messages (GET /issues?rule=), fetched once per rule and shared by the expanded
// groups and the drawer, so opening a row's evidence never refetches the list it was opened from.
import { useCallback, useRef, useState } from "react";
import type { IssueRow } from "@/lib/results/explore";
import { api, ApiError } from "../../../lib/api";

export interface RuleRows {
  rows: IssueRow[] | null;
  error: ApiError | null;
}

export function useRuleRows(auditApi: string) {
  const [cache, setCache] = useState<Record<string, RuleRows>>({});
  const started = useRef(new Set<string>());

  /** Fetch a rule's rows unless already fetched or in flight. State is set only when the response arrives. */
  const load = useCallback(
    (rule: string) => {
      if (started.current.has(rule)) return;
      started.current.add(rule);
      api<IssueRow[]>(`${auditApi}/issues?rule=${encodeURIComponent(rule)}`)
        .then((rows) => setCache((c) => ({ ...c, [rule]: { rows, error: null } })))
        .catch((e: unknown) => {
          started.current.delete(rule);
          const error = e instanceof ApiError ? e : new ApiError(0, "INTERNAL", (e as Error).message);
          setCache((c) => ({ ...c, [rule]: { rows: null, error } }));
        });
    },
    [auditApi],
  );

  /** Drop a rule's rows (after an error, or to refetch) and fetch them again. */
  const retry = useCallback(
    (rule: string) => {
      started.current.delete(rule);
      setCache((c) => {
        const next = { ...c };
        delete next[rule];
        return next;
      });
      load(rule);
    },
    [load],
  );

  return { cache, load, retry };
}
