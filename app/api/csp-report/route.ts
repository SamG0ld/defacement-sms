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

import { clientIpFromHeaders } from "@/lib/client-ip";
import { BodyTooLargeError, readBoundedBytes } from "@/lib/http-body";
import { checkActionRateLimit } from "@/lib/ratelimit";

const MAX_REPORT_BYTES = 32 * 1024;

export async function POST(req: Request): Promise<Response> {
  // Shared derivation (reads x-forwarded-for from the trusted right-hand end) so
  // this limiter can't be sidestepped by a forged header either.
  const ip = clientIpFromHeaders(req.headers);
  const { success } = await checkActionRateLimit(`csp:${ip}`);
  // Silently drop over-budget reports — browsers fire-and-forget these, and
  // the first window of reports is plenty of signal.
  if (!success) return new Response(null, { status: 204 });

  // Cheap fast-path reject on the declared length. Advisory only: it's
  // sender-supplied and simply absent under chunked transfer-encoding, so it
  // can never be the authoritative cap — the bounded read below is (#200).
  const declaredLen = Number(req.headers.get("content-length") ?? 0);
  if (declaredLen > MAX_REPORT_BYTES) return new Response(null, { status: 413 });

  // Stream with an early abort rather than buffering the whole body first. This
  // is the app's only unauthenticated route, so the bounded read has to be the
  // control that holds on its own: the limiter above caps request *rate*, not the
  // size of any single body, so without this one oversized report still lands
  // whole in memory and in the log.
  let text: string;
  try {
    const bytes = await readBoundedBytes(req.body, MAX_REPORT_BYTES);
    text = new TextDecoder().decode(bytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return new Response(null, { status: 413 });
    }
    // A body that errors mid-stream (dropped connection) is the reporter's
    // problem, not ours — browsers fire-and-forget these. Still leave a line:
    // silence here would also hide a bug in the reader itself. No body content.
    console.warn(
      JSON.stringify({
        level: "warn",
        scope: "csp-report.body-read-failed",
        message: err instanceof Error ? err.message : String(err),
      }),
    );
    return new Response(null, { status: 204 });
  }

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
