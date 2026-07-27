import type { NextConfig } from "next";

// Static security response headers. NOTE: the Content-Security-Policy is NOT set
// here — it needs a per-request nonce, so it's built in lib/csp.ts and emitted by
// proxy.ts on every HTML route. Keeping CSP in exactly one place avoids the browser
// intersecting two competing CSP headers (which would silently re-block scripts).
// Everything below is static and safe to emit on every route.
const SECURITY_HEADERS = [
  // Force HTTPS for 2 years; preload-eligible. No effect over http://, so
  // local dev is unaffected.
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  // Disable legacy/sensitive APIs we don't use.
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), interest-cohort=(), payment=(), usb=()",
  },
  // Named endpoint for the CSP `report-to csp-endpoint` directive (set in lib/csp.ts).
  { key: "Reporting-Endpoints", value: 'csp-endpoint="/api/csp-report"' },
];

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) so the
  // Docker runtime image carries only the traced deps, not the full node_modules
  // or source tree. See Dockerfile / DEPLOY.md.
  output: "standalone",
  // Denial-of-wallet (m16): the app uses plain <img> everywhere and serves art
  // bytes through its own auth-gated API routes — nothing imports next/image. Yet
  // Next's /_next/image optimizer is live by default, so an attacker could hammer
  // /_next/image?url=…&w=…&q=… across many size/quality combos to rack up billed
  // image transforms on a feature we don't use. Disabling it fully closes that
  // endpoint with zero functional impact today. To re-enable later (if the art
  // pipeline ever adopts next/image), do NOT just delete this — re-enable WITH
  // constraints: set `qualities`, `deviceSizes`/`imageSizes`, `localPatterns`,
  // `remotePatterns: []`, and `dangerouslyAllowSVG: false`, so the optimizer can't
  // be driven across unbounded transform combinations.
  images: { unoptimized: true },
  // Inline the deploy identity into the CLIENT bundle so browser Sentry events
  // (instrumentation-client.ts) carry the same environment + release tags as the
  // server/edge configs. VERCEL_ENV / VERCEL_GIT_COMMIT_SHA aren't NEXT_PUBLIC, so
  // they must be exposed here; empty string when unset (local/dev).
  env: {
    SENTRY_ENVIRONMENT: process.env.VERCEL_ENV ?? process.env.NODE_ENV ?? "",
    SENTRY_RELEASE: process.env.VERCEL_GIT_COMMIT_SHA ?? "",
  },
  experimental: {
    // Floor-map uploads (admin) can be larger than the 1 MB default. Allow up to
    // 12 MB so the app-level validator (10 MB cap, lib/image-upload) is what
    // rejects oversize images with a friendly message, not the framework.
    serverActions: { bodySizeLimit: "12mb" },
  },
  async headers() {
    return [
      {
        source: "/:path*",
        headers: SECURITY_HEADERS,
      },
      {
        // The service worker must be served as JS and never cached, so a new
        // worker rolls out the moment users reload (paired with
        // updateViaCache:"none" at registration). Scope is the whole origin, so
        // it must not be served from a stale HTTP cache.
        source: "/sw.js",
        headers: [
          {
            key: "Content-Type",
            value: "application/javascript; charset=utf-8",
          },
          { key: "Cache-Control", value: "no-cache, no-store, must-revalidate" },
        ],
      },
    ];
  },
};

export default nextConfig;
