"use client";

import { useMemo, useState } from "react";

import type { DeploySignView } from "@/lib/deploy/contract";
import type { DeployStore } from "../_lib/store";
import { filterSignsByQuery, normalizeQuery } from "../_lib/search";
import { DeploySheet } from "./DeploySheet";

type Buckets = {
  claimable: DeploySignView[];
  myClaims: DeploySignView[];
  deployed: DeploySignView[];
  othersClaimedCount: number;
};

function zoneLabel(s: DeploySignView): string {
  return s.zoneId ? `Zone ${s.zoneId}` : "Unzoned";
}

function SignRow({
  sign,
  pending,
  right,
  onToggle,
  selected,
}: {
  sign: DeploySignView;
  pending: boolean;
  right?: React.ReactNode;
  onToggle?: () => void;
  selected?: boolean;
}) {
  return (
    <li
      className={`flex items-center gap-3 rounded-lg border p-3 ${
        selected
          ? "border-accent bg-zinc-900"
          : "border-zinc-800 bg-zinc-950"
      }`}
      onClick={onToggle}
      role={onToggle ? "button" : undefined}
    >
      {onToggle && (
        <input
          type="checkbox"
          checked={!!selected}
          readOnly
          className="h-5 w-5 accent-[var(--accent)]"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-100">{sign.itemId}</span>
          {pending && (
            <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">
              syncing
            </span>
          )}
        </div>
        {sign.signText && (
          <p className="truncate text-xs text-zinc-500">{sign.signText}</p>
        )}
        <p className="text-[11px] text-zinc-600">{zoneLabel(sign)}</p>
      </div>
      {right}
    </li>
  );
}

export function SignList({
  buckets,
  pendingSignIds,
  store,
}: {
  buckets: Buckets;
  pendingSignIds: Set<number>;
  store: DeployStore;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [deployTarget, setDeployTarget] = useState<DeploySignView | null>(null);
  const [query, setQuery] = useState("");

  const hasCrew = store.activeCrewId !== null;
  const searching = normalizeQuery(query).length > 0;

  // Client-side quick search over the already-loaded sign set — instant and
  // offline-safe. Filters only the actionable lists; selection state below still
  // tracks the full claimable bucket, so a selection survives a filter change.
  const filteredMyClaims = useMemo(
    () => filterSignsByQuery(buckets.myClaims, query),
    [buckets.myClaims, query],
  );
  const filteredClaimable = useMemo(
    () => filterSignsByQuery(buckets.claimable, query),
    [buckets.claimable, query],
  );

  // A sign can leave the claimable bucket between renders (another crew claimed
  // it, or it got deployed). Rather than mutate `selected` from an effect, derive
  // the EFFECTIVE selection as selected ∩ claimable at point of use — so the
  // sticky "Claim N" count and the claim call never include a sign that's no
  // longer claimable, and the raw `selected` set just carries harmless stale ids.
  const claimableIds = useMemo(
    () => new Set(buckets.claimable.map((s) => s.id)),
    [buckets.claimable],
  );
  const effectiveSelected = useMemo(
    () => new Set([...selected].filter((id) => claimableIds.has(id))),
    [selected, claimableIds],
  );

  const toggle = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const claimSelected = () => {
    const ids = [...effectiveSelected];
    if (ids.length > 0) {
      void store.claim(ids);
      setSelected(new Set());
    }
  };

  return (
    <div className="space-y-6 pb-24">
      {/* Quick search — item ID or sign text, instant + offline */}
      <div className="relative">
        <input
          type="text"
          inputMode="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search item ID or text…"
          aria-label="Search signs by item ID or text"
          className="w-full rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-accent focus:outline-none"
        />
        {searching && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute inset-y-0 right-2 my-auto h-6 rounded px-2 text-xs text-zinc-400 hover:bg-zinc-800"
            aria-label="Clear search"
          >
            Clear
          </button>
        )}
      </div>

      {/* My crew's claimed, deployable signs */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          My crew · ready to deploy (
          {searching
            ? `${filteredMyClaims.length} of ${buckets.myClaims.length}`
            : buckets.myClaims.length}
          )
        </h2>
        {buckets.myClaims.length === 0 ? (
          <p className="text-sm text-zinc-600">
            Nothing claimed yet — claim signs below.
          </p>
        ) : filteredMyClaims.length === 0 ? (
          <p className="text-sm text-zinc-600">No matches in your claims.</p>
        ) : (
          <ul className="space-y-2">
            {filteredMyClaims.map((s) => (
              <SignRow
                key={s.id}
                sign={s}
                pending={pendingSignIds.has(s.id)}
                right={
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => store.release([s.id])}
                      className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                    >
                      Release
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeployTarget(s)}
                      className="btn-primary rounded px-3 py-1 text-xs font-medium"
                    >
                      Deploy
                    </button>
                  </div>
                }
              />
            ))}
          </ul>
        )}
      </section>

      {/* Claimable (sorted + unclaimed) */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-400">
          Claimable (
          {searching
            ? `${filteredClaimable.length} of ${buckets.claimable.length}`
            : buckets.claimable.length}
          )
        </h2>
        {!hasCrew && (
          <p className="text-sm text-highlight">
            Pick or start a crew above to claim signs.
          </p>
        )}
        {buckets.claimable.length === 0 ? (
          <p className="text-sm text-zinc-600">No unclaimed sorted signs.</p>
        ) : filteredClaimable.length === 0 ? (
          <p className="text-sm text-zinc-600">No matching claimable signs.</p>
        ) : (
          <ul className="space-y-2">
            {filteredClaimable.map((s) => (
              <SignRow
                key={s.id}
                sign={s}
                pending={pendingSignIds.has(s.id)}
                selected={effectiveSelected.has(s.id)}
                onToggle={hasCrew ? () => toggle(s.id) : undefined}
              />
            ))}
          </ul>
        )}
      </section>

      {/* Deployed (recent) + others' locks summary */}
      <section className="space-y-1 text-xs text-zinc-600">
        <p>Deployed: {buckets.deployed.length}</p>
        {buckets.othersClaimedCount > 0 && (
          <p>Claimed by other crews: {buckets.othersClaimedCount}</p>
        )}
      </section>

      {/* Sticky batch-claim action bar */}
      {hasCrew && effectiveSelected.size > 0 && (
        <div className="fixed inset-x-0 bottom-0 z-40 border-t border-zinc-800 bg-zinc-950/95 p-3 backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="text-sm text-zinc-400 hover:text-zinc-200"
            >
              Clear ({effectiveSelected.size})
            </button>
            <button
              type="button"
              onClick={claimSelected}
              className="btn-primary rounded px-4 py-2 text-sm font-medium"
            >
              Claim {effectiveSelected.size} sign
              {effectiveSelected.size === 1 ? "" : "s"}
            </button>
          </div>
        </div>
      )}

      {deployTarget && (
        <DeploySheet
          sign={deployTarget}
          onCancel={() => setDeployTarget(null)}
          onConfirm={(opts) => {
            void store.deploy(deployTarget.id, opts);
            setDeployTarget(null);
          }}
        />
      )}
    </div>
  );
}
