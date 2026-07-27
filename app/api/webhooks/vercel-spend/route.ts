import { NextResponse } from "next/server";

import { sendSpendAlertEmail } from "@/lib/email";
import { logError, logWarn } from "@/lib/log";
import {
  interpretSpendEvent,
  parseProjectIds,
  pauseProject,
  verifyVercelSignature,
  type SpendDecision,
} from "@/lib/vercel-spend";

// node:crypto signature verification + outbound fetch to the Vercel REST API —
// Node runtime, not edge.
export const runtime = "nodejs";

// Vercel Spend Management webhook (denial-of-wallet kill-switch, m16). Verifies
// the HMAC-SHA1 signature, then on a 100%-threshold event pauses the configured
// project(s) so the site 503s instead of accruing an open-ended bill. Always ACKs
// a *verified* request (200) so Vercel doesn't retry-storm; rejects an unverified
// one (401). Fails closed when VERCEL_WEBHOOK_SECRET is unset.
export async function POST(req: Request) {
  const secret = process.env.VERCEL_WEBHOOK_SECRET;
  const rawBody = await req.text();
  const signature = req.headers.get("x-vercel-signature");

  if (!verifyVercelSignature(rawBody, signature, secret)) {
    return new NextResponse("Invalid signature", { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    // Verified sender but unparseable body: ACK so Vercel stops retrying, but log
    // loudly — it means the payload shape changed and routing may be stale.
    logError("vercel-spend.bad-payload", new Error("unparseable JSON body"));
    return NextResponse.json({ ok: true });
  }

  const decision = interpretSpendEvent(event);

  if (decision.action === "pause") {
    await handlePause(decision);
  } else if (decision.action === "notify") {
    // 50%/75% climb + end-of-cycle: structured warn (filterable by scope), not an
    // error — spend is rising but nothing has tripped yet.
    logWarn("vercel-spend.threshold", decision.reason, {
      thresholdPercent: decision.thresholdPercent,
    });
  } else {
    // ignore: unrecognized payload shape — still log it so a future change to
    // Vercel's webhook schema is debuggable instead of silently dropped.
    logWarn("vercel-spend.ignored", decision.reason);
  }

  return NextResponse.json({ ok: true, action: decision.action });
}

// Trip the kill-switch: pause every configured project, emit one page-worthy
// structured alert (logError → Vercel logs + Sentry), and send a best-effort
// alert email. Swallows its own errors — a verified spend event must still 200 so
// Vercel doesn't retry-storm.
async function handlePause(decision: SpendDecision): Promise<void> {
  const token = process.env.VERCEL_API_TOKEN;
  const teamId = process.env.VERCEL_TEAM_ID;
  const projectIds = parseProjectIds(process.env.VERCEL_PROJECT_IDS);
  const selfPauseConfigured = Boolean(token) && projectIds.length > 0;

  const paused: string[] = [];
  const failed: string[] = [];

  if (selfPauseConfigured) {
    for (const id of projectIds) {
      try {
        await pauseProject(id, { token: token!, teamId });
        paused.push(id);
      } catch (err) {
        failed.push(id);
        logError("vercel-spend.pause-failed", err, { projectId: id });
      }
    }
  }

  // One page-worthy event. Logged at error level on purpose: the spend kill-switch
  // firing is exactly what we want surfaced in Sentry, even though it isn't a code
  // fault. Alert on scope `vercel-spend.cap-reached`. When self-pause isn't wired
  // (token/ids unset), Vercel's own spend "pause production" toggle is the primary
  // kill-switch — this webhook is the redundant, observable backstop.
  logError("vercel-spend.cap-reached", new Error(decision.reason), {
    thresholdPercent: decision.thresholdPercent,
    pausedProjects: paused,
    failedProjects: failed,
    selfPauseConfigured,
  });

  const alertTo = process.env.SPEND_ALERT_EMAIL;
  if (alertTo) {
    await sendSpendAlertEmail(alertTo, {
      reason: decision.reason,
      pausedProjects: paused,
    }).catch((err) => logError("vercel-spend.alert-email-failed", err));
  }
}
