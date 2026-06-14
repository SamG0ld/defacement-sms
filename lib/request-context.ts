// Audit context for sign-in events: a coarse location label + the device's raw
// User-Agent. Deliberately IP-less — location comes from Vercel's edge geo
// headers, never from storing or geo-resolving the client IP.
//
// The pure formatters here carry no `next/headers` import (it's loaded
// dynamically inside captureRequestContext), so they're unit-testable without a
// Next request scope.

// Display-formats a raw User-Agent into "Browser / OS" (e.g. "Chrome / macOS").
// Best-effort: an unrecognized UA falls back to a truncated raw string; empty
// input → null. The DB stores the raw UA; this runs at render time so the parser
// can improve later without a data backfill.
export function formatUserAgent(ua: string | null | undefined): string | null {
  if (!ua) return null;
  const os = /Windows NT/.test(ua)
    ? "Windows"
    : /(iPhone|iPad|iPod)/.test(ua)
      ? "iOS"
      : /(Mac OS X|Macintosh)/.test(ua)
        ? "macOS"
        : /Android/.test(ua)
          ? "Android"
          : /Linux/.test(ua)
            ? "Linux"
            : null;
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /(OPR\/|Opera)/.test(ua)
      ? "Opera"
      : /Chrome\//.test(ua)
        ? "Chrome"
        : /Firefox\//.test(ua)
          ? "Firefox"
          : /Safari\//.test(ua)
            ? "Safari"
            : null;
  if (browser && os) return `${browser} / ${os}`;
  if (browser) return browser;
  if (os) return os;
  return ua.length > 80 ? `${ua.slice(0, 80)}…` : ua;
}

// Builds a coarse "City, CC" / "CC" label from already-decoded parts. Pure; no
// IP is involved. Empty/whitespace parts collapse out.
export function formatLocation(
  city: string | null | undefined,
  country: string | null | undefined,
): string | null {
  const c = city?.trim() || null;
  const cc = country?.trim() || null;
  if (c && cc) return `${c}, ${cc}`;
  return cc ?? c ?? null;
}

// Vercel percent-encodes the city header (e.g. "Las%20Vegas"); decode defensively.
function decodeHeader(value: string | null): string | null {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

// Captures the audit context (location + raw UA) for a sign-in. Best-effort by
// design: `next/headers` only resolves inside a request scope (the NextAuth Node
// route handler), so the whole thing is wrapped to degrade to nulls rather than
// ever throw inside an auth callback — a login must never fail because we
// couldn't record where it came from.
export async function captureRequestContext(): Promise<{
  location: string | null;
  userAgent: string | null;
}> {
  try {
    const { headers } = await import("next/headers");
    const h = await headers();
    const location = formatLocation(
      decodeHeader(h.get("x-vercel-ip-city")),
      // Country is an ISO 3166-1 alpha-2 code (ASCII) — never percent-encoded,
      // so unlike city it needs no decode.
      h.get("x-vercel-ip-country"),
    );
    const rawUa = h.get("user-agent");
    // Bound stored length — UA strings are unbounded attacker-controlled input.
    const userAgent = rawUa ? rawUa.slice(0, 400) : null;
    return { location, userAgent };
  } catch {
    return { location: null, userAgent: null };
  }
}
