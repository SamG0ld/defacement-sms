import { createHmac, timingSafeEqual } from "node:crypto";

// --- Vercel Spend Management webhook → automatic kill-switch (m16) ----------
// Denial-of-wallet defense: Vercel posts a signed webhook when team spend crosses
// a configured budget threshold. At 100% we pause the project(s) so the site 503s
// instead of running an open-ended bill against the card. Everything here is pure
// + fetch-only (no @vercel/sdk dependency) so the verification/routing logic is
// unit-testable without the network. Consumed by app/api/webhooks/vercel-spend.
// See RUNBOOK.md → "Denial-of-wallet / spend controls".

// Vercel signs webhook payloads with HMAC-SHA1 of the RAW request body, hex-
// encoded, in the `x-vercel-signature` header (Vercel "securing webhooks" doc).
// Constant-time compare so the secret can't be recovered byte-by-byte via
// response timing. Fails CLOSED — no secret or no signature → reject — because the
// route is on the proxy's public allowlist and must never be triggerable by the
// open internet. Mirrors the bearer check in app/api/cron/purge-login-audit.
export function verifyVercelSignature(
  rawBody: string,
  signature: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (!secret || !signature) return false;
  const expected = createHmac("sha1", secret).update(rawBody).digest("hex");
  // Both are hex strings (ASCII) — compare their UTF-8 bytes; explicit encoding
  // documents that and avoids any platform default ambiguity.
  const provided = Buffer.from(signature, "utf8");
  const computed = Buffer.from(expected, "utf8");
  // timingSafeEqual throws on length-mismatched buffers — short-circuit first.
  return (
    provided.length === computed.length && timingSafeEqual(provided, computed)
  );
}

export type SpendAction = "pause" | "notify" | "ignore";

export interface SpendDecision {
  readonly action: SpendAction;
  readonly reason: string;
  readonly thresholdPercent: number | null;
}

// Map a verified Spend Management payload to an action. Two payload shapes
// (confirmed against Vercel's spend-management doc):
//   threshold:     { budgetAmount, currentSpend, teamId, thresholdPercent }  // 50 | 75 | 100
//   end of cycle:  { teamId, type: "endOfBillingCycle" }
//
//   >= 100%            → PAUSE (trip the kill-switch).
//   50% / 75%          → notify (loud log; spend is climbing, no action yet).
//   endOfBillingCycle  → notify only. We deliberately DO NOT auto-unpause —
//                        resuming is a human call after confirming the spike is
//                        over (an attacker-driven pause that auto-lifts at cycle
//                        rollover would just re-expose the wallet).
//   anything else      → ignore.
export function interpretSpendEvent(event: unknown): SpendDecision {
  const obj = (event ?? {}) as Record<string, unknown>;
  const threshold =
    typeof obj.thresholdPercent === "number" ? obj.thresholdPercent : null;

  if (threshold !== null) {
    if (threshold >= 100) {
      return {
        action: "pause",
        reason: `Spend reached ${threshold}% of the configured budget — auto-pausing.`,
        thresholdPercent: threshold,
      };
    }
    return {
      action: "notify",
      reason: `Spend reached ${threshold}% of the configured budget.`,
      thresholdPercent: threshold,
    };
  }

  if (obj.type === "endOfBillingCycle") {
    return {
      action: "notify",
      reason:
        "End of billing cycle — not auto-unpausing; resume is a deliberate manual step.",
      thresholdPercent: null,
    };
  }

  return {
    action: "ignore",
    reason: "Unrecognized spend event.",
    thresholdPercent: threshold,
  };
}

export interface VercelApiConfig {
  readonly token: string;
  readonly teamId?: string;
}

const VERCEL_API_BASE = "https://api.vercel.com";

// Pause a single project via the Vercel REST API (confirmed endpoint:
// POST /v1/projects/{id}/pause?teamId=…, Bearer auth, 200 + {} on success).
// Plain fetch — no @vercel/sdk dependency. `encodeURIComponent` on the id keeps a
// malformed value from path-traversing the API URL. Throws on a non-2xx so the
// caller can log per-project failure without aborting the rest of the loop.
export async function pauseProject(
  projectId: string,
  config: VercelApiConfig,
): Promise<void> {
  const url = new URL(
    `${VERCEL_API_BASE}/v1/projects/${encodeURIComponent(projectId)}/pause`,
  );
  if (config.teamId) url.searchParams.set("teamId", config.teamId);

  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${config.token}` },
  });

  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 500);
    throw new Error(
      `Vercel pause failed for project ${projectId} (${res.status}): ${detail}`,
    );
  }
}

// Parse VERCEL_PROJECT_IDS (comma-separated) into a clean list. Exported so the
// route and its tests share one parser.
export function parseProjectIds(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
