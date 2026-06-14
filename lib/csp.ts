// Content Security Policy helpers for the per-request, nonce-based CSP set in
// proxy.ts. Pure and edge-safe (Web Crypto + btoa only — no Node APIs), so the
// exact same functions run in the Edge runtime AND under vitest (node), which is
// what lets tests/unit/csp.test.ts import and exercise the real code.
//
// Why CSP lives in proxy.ts and not next.config.ts: a per-request nonce can only
// be minted at request time. proxy.ts sets the nonce-bearing CSP on BOTH the
// request headers (so Next reads the nonce and stamps it onto its framework /
// hydration <script> tags) and the response headers (so the browser enforces it).
// next.config.ts keeps only the static, non-CSP security headers — one CSP source
// avoids the browser intersecting two competing CSP headers.

export type CspMode = "enforce" | "report";

// 16 random bytes → base64url (no padding) = 22 chars. crypto.getRandomValues and
// btoa are both present in the Edge runtime and in Node (vitest).
export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Array.from avoids needing downlevelIteration for a Uint8Array spread.
  const binary = Array.from(bytes, (b) => String.fromCharCode(b)).join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// Builds the CSP directive string for one request. Identical to the previous
// static policy EXCEPT script-src drops 'unsafe-inline' for the per-request nonce
// + 'strict-dynamic' (which lets the nonce-trusted entry scripts load their own
// chunks). style-src keeps 'unsafe-inline' — Tailwind v4 inlines critical CSS that
// can't be nonced/hashed without significant build changes (accepted trade-off,
// issue #19).
export function buildCsp(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https://lh3.googleusercontent.com",
    "font-src 'self' data:",
    "connect-src 'self' https://accounts.google.com",
    "frame-src 'self' https://accounts.google.com",
    "frame-ancestors 'none'",
    "form-action 'self' https://accounts.google.com",
    "base-uri 'self'",
    "object-src 'none'",
    // PWA: Chromium gates the service worker on worker-src specifically, so it
    // must be explicit even though default-src 'self' would otherwise cover it.
    "worker-src 'self'",
    "manifest-src 'self'",
    // Violation reports → /api/csp-report. report-to is the modern mechanism (via
    // the Reporting-Endpoints header set statically in next.config.ts); report-uri
    // is the legacy fallback.
    "report-to csp-endpoint",
    "report-uri /api/csp-report",
  ].join("; ");
}

// enforce in production by default; report-only in dev. Override with CSP_MODE.
// Moved verbatim from next.config.ts so policy + mode live in one place.
export function resolveCspMode(): CspMode {
  const mode =
    process.env.CSP_MODE ??
    (process.env.NODE_ENV === "production" ? "enforce" : "report");
  return mode === "enforce" ? "enforce" : "report";
}

// Response header name for the resolved mode. The REQUEST header Next reads to
// learn the nonce is ALWAYS the enforce-named "Content-Security-Policy" (set in
// proxy.ts) regardless of mode — report-only is purely about what the browser does
// with the response, not about whether Next stamps the nonce.
export function cspResponseHeaderName(mode: CspMode): string {
  return mode === "enforce"
    ? "Content-Security-Policy"
    : "Content-Security-Policy-Report-Only";
}
