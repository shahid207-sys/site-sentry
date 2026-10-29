import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

const nextConfig: NextConfig = {
  /* config options here */
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  // BullMQ loads its Lua scripts from disk at runtime; keep it (and its Redis client) out of the server bundle.
  serverExternalPackages: ["bullmq", "ioredis"],
  // .data holds runtime state (the JSON store, raw-HTML blobs, gate and validation runs): never part of a server trace.
  outputFileTracingExcludes: { "/*": [".data/**/*"] },
  // Keep the dev-only indicator away from the sidebar controls at bottom-left.
  devIndicators: { position: "bottom-right" },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Report share links: these headers replace the site-wide ones above (the last matching entry wins; a route's
      // own header of the same name does not). Same values as SHARE_HEADERS in src/lib/report/shares.ts.
      {
        source: "/r/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
        ],
      },
    ];
  },
  async redirects() {
    // The workspace lives at /live (and /sample); /app is an alias for people who expect that path.
    return [
      { source: "/app", destination: "/live", permanent: false },
      { source: "/app/fix-queue", destination: "/live/tasks", permanent: false },
      { source: "/app/:path*", destination: "/live/:path*", permanent: false },
    ];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
