"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, FlaskConical, Globe } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { describeLimits, HERO_PROFILE, HERO_RATE_LIMIT, PROFILES } from "@/lib/crawl/profiles";
import type { Site } from "@/lib/model";
import { parsePublicUrl } from "@/lib/public-url";
import type { AuditSummary } from "@/lib/views";
import { api, ApiError } from "../lib/api";
import { Button, cx, LinkButton } from "../ui";

/** Bounded on purpose: the homepage form runs the Quick profile only (the server enforces it and the per-IP limit). */
const QUICK = PROFILES[HERO_PROFILE];

type Phase = "idle" | "site" | "audit";

export function HeroAuditForm({ compact }: { compact?: boolean }) {
  const router = useRouter();
  const inputId = useId();
  const hintId = useId();
  const errorId = useId();
  const [value, setValue] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<{ message: string; offerSample?: "workspace" | "audit" } | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = parsePublicUrl(value);
    if ("error" in parsed) return setError({ message: parsed.error });
    setError(null);
    const host = new URL(parsed.url).hostname;
    try {
      setPhase("site");
      let siteId: string;
      try {
        siteId = (await api<Site>("/api/live/sites", { method: "POST", body: { name: host, origin: parsed.url } })).id;
      } catch (err) {
        // Already set up: audit the existing site instead of failing.
        const existing = err instanceof ApiError && err.status === 409 ? err.details?.siteId : undefined;
        if (typeof existing !== "string") throw err;
        siteId = existing;
      }
      setPhase("audit");
      const { audit } = await api<{ audit: AuditSummary }>("/api/live/audits/quick", { method: "POST", body: { siteId, url: parsed.url } });
      router.push(`/live/audits/${audit.id}`);
    } catch (err) {
      setPhase("idle");
      if (err instanceof ApiError) {
        // PROXY_NOT_CONFIGURED: the server's message already points to the sample audit; link it.
        const offerSample = err.code === "PROXY_NOT_CONFIGURED" ? "audit" : err.code === "LIVE_DISABLED" || err.status === 0 ? "workspace" : undefined;
        setError({ message: err.message, offerSample });
      } else {
        setError({ message: "Something went wrong starting the audit. Nothing was saved; try again." });
      }
    }
  }

  const busy = phase !== "idle";
  return (
    <div>
      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-2 rounded-2xl border border-line bg-surface p-2 shadow-raised transition-shadow focus-within:border-accent/50 focus-within:ring-4 focus-within:ring-accent/10 sm:flex-row sm:items-center">
        <label htmlFor={inputId} className="sr-only">
          Website address
        </label>
        <Globe className="ml-3 hidden size-5 shrink-0 text-fg-3 sm:block" aria-hidden />
        <input
          id={inputId}
          name="url"
          type="text"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Enter your website URL"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (error) setError(null);
          }}
          disabled={busy}
          aria-invalid={error ? true : undefined}
          aria-describedby={cx(hintId, error && errorId) || undefined}
          className="h-12 min-w-0 flex-1 rounded-xl bg-transparent px-4 text-base sm:px-1 text-fg placeholder:text-fg-3 focus:outline-none focus-visible:outline-none disabled:opacity-60"
        />
        <Button type="submit" variant="primary" loading={busy} className="h-12 rounded-xl px-6 text-base font-semibold">
          {phase === "site" ? "Adding site…" : phase === "audit" ? "Starting audit…" : "Get free audit"}
          {!busy ? <ArrowRight className="size-4" aria-hidden /> : null}
        </Button>
      </form>
      <div aria-live="polite">
        {error ? (
          <div id={errorId} role="alert" className="mt-3 rounded-lg border border-sev-high/25 bg-sev-high-soft px-3.5 py-2.5 text-sm text-sev-high">
            {error.message}
            {error.offerSample === "audit" ? (
              <>
                {" "}
                <Link href="/sample-audit" className="font-medium underline underline-offset-4">
                  Open the sample audit
                </Link>
              </>
            ) : error.offerSample ? (
              <>
                {" "}
                <Link href="/sample" className="font-medium underline underline-offset-4">
                  Explore the sample workspace instead
                </Link>
                .
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      <p id={hintId} className={cx("mt-3 text-[13px] text-fg-3", compact && "sr-only")}>
        {QUICK.label} audit of the address you enter: {describeLimits(QUICK.budget, QUICK.maxDepth)}. Up to {HERO_RATE_LIMIT.audits} free audits an hour. Respects robots.txt. Results are saved to your workspace.
      </p>
      {compact ? null : <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2">
        <LinkButton href="/sample-audit" icon={FlaskConical} aria-label="Explore an interactive sample audit">
          Explore sample audit
        </LinkButton>
        <span className="text-[13px] text-fg-3">Fictional site, real engine output. No setup.</span>
      </div>}
    </div>
  );
}
