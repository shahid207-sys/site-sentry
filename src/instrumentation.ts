// Server start hook (Next calls register() once per server instance). Starts the scheduled-audit tick on the Node.js
// runtime only; the tick itself lives in instrumentation-node.ts so the Edge bundle never sees its imports.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") await import("./instrumentation-node");
}
