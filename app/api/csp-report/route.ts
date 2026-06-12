// POST /api/csp-report — CSP violation collector (see next.config.ts). Browsers
// post here on a violation in BOTH header modes, so report-only runs gather
// server-side telemetry and the report→enforce flip is data-driven across every
// route/browser instead of relying on someone watching a devtools console.
//
// Unauthenticated by design (the browser sends reports outside any session —
// proxy.ts allowlists this path), so it stays paranoid: bounded body, log-only,
// no echo, JSON.stringify escapes newlines so a crafted report can't forge log
// lines, and a per-IP limiter caps log-flooding. The limiter deliberately uses
// its own key namespace — NEVER the auth bucket, or spamming reports could
// exhaust an IP's login budget.

import { checkActionRateLimit } from "@/lib/ratelimit";

const MAX_REPORT_BYTES = 32 * 1024;

export async function POST(req: Request): Promise<Response> {
  const ip =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const { success } = await checkActionRateLimit(`csp:${ip}`);
  // Silently drop over-budget reports — browsers fire-and-forget these, and
  // the first window of reports is plenty of signal.
  if (!success) return new Response(null, { status: 204 });

  const declaredLen = Number(req.headers.get("content-length") ?? 0);
  if (declaredLen > MAX_REPORT_BYTES) return new Response(null, { status: 413 });

  const text = await req.text();
  if (text.length > MAX_REPORT_BYTES) return new Response(null, { status: 413 });

  try {
    // report-uri wraps as { "csp-report": {...} }; report-to sends an array of
    // { type: "csp-violation", body: {...} }. Log either shape, truncated.
    const report = JSON.parse(text);
    console.warn("[csp-report]", JSON.stringify(report).slice(0, 2000));
  } catch {
    console.warn("[csp-report] unparseable report body");
  }
  return new Response(null, { status: 204 });
}
