"use client";

import { useState } from "react";

export function AuditForm({
  loading,
  onAudit,
  onSample,
}: {
  loading: "live" | "sample" | null;
  onAudit: (url: string) => void;
  onSample: () => void;
}) {
  const [url, setUrl] = useState("");

  return (
    <form
      className="flex flex-col gap-3 sm:flex-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (url.trim()) onAudit(url.trim());
      }}
    >
      <label htmlFor="url" className="sr-only">
        Public URL to audit
      </label>
      <input
        id="url"
        type="text"
        inputMode="url"
        autoComplete="url"
        placeholder="https://example.com/page"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        className="min-w-0 flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent/30"
      />
      <button
        type="submit"
        disabled={loading !== null || !url.trim()}
        className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
      >
        {loading === "live" ? "Auditing…" : "Run audit"}
      </button>
      <button
        type="button"
        onClick={onSample}
        disabled={loading !== null}
        className="rounded-lg border border-line px-4 py-2 text-sm font-medium disabled:opacity-50"
      >
        {loading === "sample" ? "Loading…" : "Load sample audit"}
      </button>
    </form>
  );
}
