"use client";

import type { DeploySignView } from "@/lib/deploy/contract";

// Desktop-only preview pane for /deploy's right rail. Pure presentational — fed a
// focused sign (resolved fresh from the store by DeployApp, so it reflects live
// claim/deploy state) plus whether the active crew may deploy it. Clicking a sign
// row on desktop focuses it here; the Deploy button reuses the single DeploySheet
// flow via onDeploy rather than introducing a second deploy path. No store access.

function zoneLabel(s: DeploySignView): string {
  return s.zoneId ? `Zone ${s.zoneId}` : "Unzoned";
}

function shortTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
}

export function FocusPane({
  sign,
  pending,
  canDeploy,
  onDeploy,
}: {
  sign: DeploySignView | null;
  pending: boolean;
  canDeploy: boolean;
  onDeploy: (sign: DeploySignView) => void;
}) {
  // Reserve height in the empty state so focusing/clearing a sign doesn't shift
  // the rail layout (no CLS).
  if (!sign) {
    return (
      <div className="panel flex min-h-[180px] items-center justify-center p-4 text-center text-sm text-zinc-600">
        Select a sign to preview it here.
      </div>
    );
  }

  const deployed = sign.status === "deployed";
  const claimState = deployed
    ? "Deployed"
    : canDeploy
      ? "Claimed by your crew"
      : sign.claimedByCrewId !== null
        ? "Claimed by another crew"
        : "Unclaimed";
  const claimedTime = shortTime(sign.claimedAt);
  const deployedTime = shortTime(sign.deployedAt);

  return (
    <div className="panel space-y-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-base font-semibold text-zinc-100">
          {sign.itemId}
        </span>
        <span className={`badge badge-${sign.status}`}>{sign.status}</span>
      </div>

      {sign.signText && <p className="text-sm text-zinc-300">{sign.signText}</p>}

      <dl className="space-y-1.5 text-xs">
        <div className="flex justify-between gap-3">
          <dt className="text-zinc-500">Zone</dt>
          <dd className="text-zinc-300">{zoneLabel(sign)}</dd>
        </div>
        <div className="flex justify-between gap-3">
          <dt className="text-zinc-500">State</dt>
          <dd className="text-zinc-300">{claimState}</dd>
        </div>
        {!deployed && claimedTime && (
          <div className="flex justify-between gap-3">
            <dt className="text-zinc-500">Claimed</dt>
            <dd className="font-mono text-zinc-400">{claimedTime}</dd>
          </div>
        )}
        {deployed && deployedTime && (
          <div className="flex justify-between gap-3">
            <dt className="text-zinc-500">Deployed</dt>
            <dd className="font-mono text-zinc-400">{deployedTime}</dd>
          </div>
        )}
        {pending && (
          <div className="flex justify-between gap-3">
            <dt className="text-zinc-500">Sync</dt>
            <dd className="text-highlight">syncing…</dd>
          </div>
        )}
      </dl>

      {deployed && sign.deployPhotoUrl && (
        // Fixed aspect ratio so the panel doesn't jump height on image load
        // (the rail is sticky, so a late reflow would shift it).
        <div className="aspect-video w-full overflow-hidden rounded border border-[var(--line)]">
          {/* eslint-disable-next-line @next/next/no-img-element -- auth-gated deploy photo */}
          <img
            src={sign.deployPhotoUrl}
            alt={`Deployed ${sign.itemId}`}
            className="h-full w-full object-cover"
          />
        </div>
      )}

      {canDeploy && (
        <button
          type="button"
          onClick={() => onDeploy(sign)}
          className="btn btn-primary w-full justify-center"
        >
          Deploy
        </button>
      )}
    </div>
  );
}
