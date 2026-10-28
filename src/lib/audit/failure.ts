// How a failed audit's error reads in the UI. Pure, so both failure notices share it and it can be tested.

/** Codes a failure notice shows as a label: failures the crawler recorded on purpose, which a user can act on. */
const LABELLED = new Set(["scope_rule_invalid", "start_redirected_off_host"]);

export function failureText(error: { code: string; message: string } | undefined, fallback: string): { label: string | null; message: string } {
  if (!error) return { label: null, message: fallback };
  return { label: LABELLED.has(error.code) ? error.code : null, message: error.message };
}
