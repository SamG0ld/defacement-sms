import type { NextConfig } from "next";

// Content Security Policy — emitted as enforcing or report-only based on
// CSP_MODE (defaults: enforce in production, report in dev). Start a fresh
// deploy with CSP_MODE=report, watch for violations, then flip to enforce.
//
// Allowlist rationale:
//   - script-src 'self' + 'unsafe-inline': Next.js ships hydration scripts inline.
//     Switch to nonces once we bake them into the response.
//   - style-src 'self' + 'unsafe-inline': Tailwind v4 inlines critical CSS.
//   - img-src lh3.googleusercontent.com: Google profile pictures from OAuth.
//   - connect-src accounts.google.com: OAuth XHR.
//   - frame-src accounts.google.com: OAuth popup/iframe.
//   - form-action accounts.google.com: OAuth form posts.
const CSP_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: https://lh3.googleusercontent.com",
  "font-src 'self' data:",
  "connect-src 'self' https://accounts.google.com",
  "frame-src 'self' https://accounts.google.com",
  "frame-ancestors 'none'",
  "form-action 'self' https://accounts.google.com",
  "base-uri 'self'",
  "object-src 'none'",
  // PWA: allow our own service worker (public/sw.js) and web app manifest. Both
  // are same-origin; default-src 'self' would cover them, but Chromium gates the
  // SW on worker-src specifically, so it must be explicit.
  "worker-src 'self'",
  "manifest-src 'self'",
].join("; ");

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
];

// enforce in production by default; report-only in dev. Override with CSP_MODE.
const cspMode =
  process.env.CSP_MODE ??
  (process.env.NODE_ENV === "production" ? "enforce" : "report");
const cspHeaderKey =
  cspMode === "enforce"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";

const ALL_HEADERS = [
  ...SECURITY_HEADERS,
  { key: cspHeaderKey, value: CSP_DIRECTIVES },
];

const nextConfig: NextConfig = {
  // Emit a self-contained server bundle (.next/standalone/server.js) so the
  // Docker runtime image carries only the traced deps, not the full node_modules
  // or source tree. See Dockerfile / DEPLOY.md.
  output: "standalone",
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
        headers: ALL_HEADERS,
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
