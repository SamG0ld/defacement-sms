// Client IP extraction for the IP-keyed rate limiters (the auth limiter in
// proxy.ts and the login Server Actions in lib/sign-in.ts, plus the
// /api/csp-report log-flood cap). Pure and dependency-free so the identical
// logic runs in middleware and in Node server actions — previously it was
// duplicated in both places, and both copies trusted the spoofable end.
//
// TRUST ASSUMPTION (load-bearing). `x-forwarded-for` is a
// client-supplied header: anything the app receives is attacker-controlled
// unless a proxy in front of it rewrites the value. So we read the chain from
// the RIGHT — the last entry is the peer address the nearest trusted proxy
// actually observed, which a client cannot forge by sending its own header. A
// client that prepends "1.2.3.4," only pollutes entries we ignore, so it can no
// longer rotate the header to get a fresh rate-limit budget per request.
//
// This holds for both deploy targets:
//   - Vercel: the edge REPLACES x-forwarded-for with the real client IP, so the
//     list has one entry and rightmost == leftmost == the true client.
//   - Self-hosted behind a reverse proxy: the proxy must APPEND to the chain,
//     so the rightmost entry is the address it saw on the connection.
// Behind N chained proxies that each append, set TRUST_PROXY_DEPTH=N to skip
// their own addresses and land on the client again.

const DEFAULT_TRUST_PROXY_DEPTH = 1;

// The result becomes part of a Redis rate-limit key and is derived from an
// attacker-controlled header, so bound it. Comfortably above the 45 chars of a
// longest-form IPv6 address with room for a zone/port suffix.
const MAX_IP_LENGTH = 64;

// How many entries to count back from the right of x-forwarded-for. Read per
// call rather than cached at module load (as proxy.ts does for CSP_MODE) purely
// so a test can vary it without vi.resetModules(); the cost is one env lookup on
// a path that already awaits Redis.
export function resolveTrustProxyDepth(): number {
  const raw = process.env.TRUST_PROXY_DEPTH;
  if (!raw) return DEFAULT_TRUST_PROXY_DEPTH;
  const parsed = Number(raw.trim());
  // Exact positive integer only. A typo ("0", "-1", "2 hops") must never
  // silently widen trust, so anything else falls back to the safe default.
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_TRUST_PROXY_DEPTH;
  return parsed;
}

export function clientIpFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) {
    const hops = forwarded
      .split(",")
      .map((hop) => hop.trim())
      .filter(Boolean);
    if (hops.length > 0) {
      const depth = resolveTrustProxyDepth();
      // Count back `depth` entries from the right. If the configured depth is
      // deeper than the chain we actually received, the topology doesn't match
      // the config — clamp to the RIGHTMOST entry (what the nearest proxy
      // observed), never to the leftmost, so a misconfigured-but-unattacked
      // deployment over-throttles instead of silently trusting client input.
      //
      // The clamp is NOT a defense against an attacker: they simply prepend
      // enough entries that depth <= hops.length and the clamp never fires. An
      // overshot depth is exploitable no matter what we do here — the only real
      // protection is setting it correctly (or not at all). Closing that
      // properly needs trusted-proxy-by-CIDR rather than by count.
      const index = depth <= hops.length ? hops.length - depth : hops.length - 1;
      return hops[index].slice(0, MAX_IP_LENGTH);
    }
  }
  // Set by the same trusted proxy layer (and by Vercel). Only reached when
  // x-forwarded-for is absent or contained nothing usable.
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, MAX_IP_LENGTH);
  return "unknown";
}
