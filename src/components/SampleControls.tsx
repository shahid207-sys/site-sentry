import type { SampleState } from "@/lib/sample/sample-page";

const OPTIONS: [SampleState, string][] = [
  ["broken", "Original (broken)"],
  ["fixed", "Fix deployed"],
  ["offline", "Site offline"],
];

/** SAMPLE ONLY: simulate changes to the demo site so re-scan outcomes can be demonstrated. */
export function SampleControls({ state, onChange }: { state: SampleState; onChange: (s: SampleState) => void }) {
  return (
    <section className="mt-6 rounded-lg border border-amber-400 bg-amber-50 p-4 text-sm dark:border-amber-700 dark:bg-amber-950">
      <p className="font-semibold text-amber-950 dark:text-amber-100">SAMPLE SITE SIMULATOR</p>
      <p className="mt-1 text-amber-900 dark:text-amber-200">
        Changes what the bundled demo page returns on the next re-scan of a sample finding. Live findings are unaffected.
      </p>
      <div role="radiogroup" aria-label="Sample site state" className="mt-3 flex flex-wrap gap-2">
        {OPTIONS.map(([value, label]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={state === value}
            onClick={() => onChange(value)}
            className={`rounded-full border px-3 py-1 text-xs font-medium ${
              state === value ? "border-amber-700 bg-amber-700 text-white" : "border-amber-400 text-amber-950 dark:text-amber-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
    </section>
  );
}
