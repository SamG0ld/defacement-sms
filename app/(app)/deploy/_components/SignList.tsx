"use client";

import { useMemo, useState } from "react";

import type { DeploySignView } from "@/lib/deploy/contract";
import { isActivationKey } from "@/app/_components/keys";
import type { DeployStore } from "../_lib/store";
import { hasUsableCrew } from "../_lib/rules";
import { filterSignsByQuery, normalizeQuery } from "../_lib/search";
import { zoneLabel } from "../_lib/zone-label";

type Buckets = {
  claimable: DeploySignView[];
  myClaims: DeploySignView[];
  deployed: DeploySignView[];
  othersClaimedCount: number;
};

// One sign row. Deliberately dumb: the parent decides what a row click means
// (toggle selection on mobile, focus-for-preview on desktop) and whether the
// checkbox is interactive — the row just renders the props it's given.
function SignRow({
  sign,
  pending,
  right,
  onActivate,
  showCheckbox,
  onCheckboxToggle,
  selected,
  focused,
  ariaPressed,
}: {
  sign: DeploySignView;
  pending: boolean;
  right?: React.ReactNode;
  onActivate?: () => void;
  showCheckbox?: boolean;
  onCheckboxToggle?: () => void;
  selected?: boolean;
  focused?: boolean;
  ariaPressed?: boolean;
}) {
  const highlight = focused || selected;
  return (
    <li
      className={`flex items-center gap-3 rounded-lg border p-3 ${
        highlight
          ? "border-[var(--accent)] bg-[var(--surface-2)]"
          : "border-[var(--line)] bg-[var(--surface)]"
      } ${
        onActivate
          ? "cursor-pointer focus-visible:border-[var(--accent)] focus-visible:shadow-[var(--accent-glow)] focus-visible:outline-none"
          : ""
      }`}
      onClick={onActivate}
      // role="button" promises assistive tech a real button: in the tab order and
      // operable by Enter/Space. A bare onClick on an <li> delivered neither, so
      // keyboard and switch-control users could not claim a sign or focus the
      // preview at all — the role made it worse by announcing an operable control
      // that wasn't one. (#180)
      role={onActivate ? "button" : undefined}
      tabIndex={onActivate ? 0 : undefined}
      onKeyDown={
        onActivate
          ? (e) => {
              // Row itself only. Space belongs to the nested checkbox and Enter to
              // the Release/Deploy buttons; without this the row would fire a
              // second, conflicting action on top of theirs.
              if (e.target !== e.currentTarget) return;
              if (!isActivationKey(e.key)) return;
              e.preventDefault(); // Space would otherwise scroll the list away
              onActivate();
            }
          : undefined
      }
      aria-pressed={ariaPressed}
      aria-current={focused ? "location" : undefined}
    >
      {showCheckbox && (
        <input
          type="checkbox"
          checked={!!selected}
          // Interactive on desktop (it owns the toggle); a readOnly mirror on
          // mobile, where clicking the whole row toggles selection. stopPropagation
          // keeps a desktop checkbox click from also firing the row's focus.
          onChange={onCheckboxToggle}
          readOnly={!onCheckboxToggle}
          // Mirror-only (mobile): skip it in the tab order, or the row's new
          // tabIndex from #180 and this checkbox would be two consecutive stops
          // doing the same thing. `readOnly` is inert on checkboxes — it silences
          // React's controlled-input warning but does NOT stop native Space from
          // flipping it — so without this the second stop also flashes a
          // wrong checked state before the controlled re-render corrects it.
          tabIndex={onCheckboxToggle ? undefined : -1}
          onClick={onCheckboxToggle ? (e) => e.stopPropagation() : undefined}
          aria-label={`Select ${sign.itemId}`}
          className="h-5 w-5 accent-[var(--accent)]"
        />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-zinc-100">{sign.itemId}</span>
          {pending && (
            <span className="rounded bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] uppercase text-zinc-400">
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
  layout,
  focusedId,
  onFocus,
  onDeploy,
  selected,
  setSelected,
  query,
  setQuery,
}: {
  buckets: Buckets;
  pendingSignIds: Set<number>;
  store: DeployStore;
  // Mobile = single-column field flow (row click toggles claim selection).
  // Desktop = denser layout; row click focuses the right-rail preview and the
  // checkbox owns selection. Deploy confirmation lives in a single DeploySheet
  // hoisted to DeployApp — opened here via onDeploy.
  layout: "mobile" | "desktop";
  focusedId: number | null;
  onFocus: (id: number) => void;
  onDeploy: (signId: number) => void;
  // Selection + search live in DeployApp, not here. DeployApp renders EITHER the
  // mobile or the desktop SignList, so a device that crosses the breakpoint
  // mid-use (a tablet rotating, a window resize, a foldable) unmounts one and
  // mounts the other — which used to silently discard an in-progress batch
  // selection and the search text along with it. (#192)
  selected: Set<number>;
  setSelected: React.Dispatch<React.SetStateAction<Set<number>>>;
  query: string;
  setQuery: React.Dispatch<React.SetStateAction<string>>;
}) {
  // In-flight guards. Each enqueue mints its own clientId, so a second tap before
  // the first await resolves creates a SEPARATE outbox entry for the same action
  // — a duplicate request and a confusing duplicate row in the queue panel. The
  // existing `pending` badge is display-only and guards nothing. (#179)
  //
  // These stay LOCAL, unlike `selected`/`query` above: they describe a request
  // this list instance has in flight, so a breakpoint switch should reset them
  // rather than carry a stale "Releasing…" into the freshly mounted list. (#192)
  const [claiming, setClaiming] = useState(false);
  const [releasing, setReleasing] = useState<Set<number>>(new Set());

  const isDesktop = layout === "desktop";
  // Not a bare non-null check: the remembered crew has to be one this user is
  // actually in, or a stale/foreign selection leaves the claim UI armed for a
  // claim the server will reject. (#189)
  const hasCrew = hasUsableCrew({
    activeCrewId: store.activeCrewId,
    myCrewIds: store.myCrewIds,
    // Membership is only KNOWN once a bootstrap actually succeeded. On an offline
    // cold start it fails, leaving myCrewIds empty for lack of data rather than
    // because the volunteer has no crew.
    membershipKnown: store.loaded && store.bootError === null,
  });
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

  const claimSelected = async () => {
    const ids = [...effectiveSelected];
    if (ids.length === 0 || claiming) return;
    // Await the durable write (store.claim surfaces its own failure) rather than
    // firing and forgetting — a dropped claim must not look successful. (#59)
    setClaiming(true);
    try {
      await store.claim(ids);
      setSelected(new Set()); // clear ONLY on success — keep the selection to retry
    } catch {
      // store.claim already surfaced a notice; keep the selection.
    } finally {
      setClaiming(false);
    }
  };

  const releaseOne = async (signId: number) => {
    if (releasing.has(signId)) return;
    setReleasing((prev) => new Set(prev).add(signId));
    try {
      // Await + store-owned error handling, not a bare fire-and-forget that
      // drops a failed release. (#65)
      await store.release([signId]);
    } catch {
      // store.release already surfaced a notice.
    } finally {
      setReleasing((prev) => {
        const next = new Set(prev);
        next.delete(signId);
        return next;
      });
    }
  };

  return (
    <div className="space-y-6 pb-4">
      {/* Quick search — item ID or sign text, instant + offline */}
      <div className="relative">
        <input
          type="text"
          inputMode="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search item ID or text…"
          aria-label="Search signs by item ID or text"
          className="field w-full"
        />
        {searching && (
          <button
            type="button"
            onClick={() => setQuery("")}
            className="absolute inset-y-0 right-2 my-auto h-6 rounded px-2 text-xs text-zinc-400 hover:bg-[var(--surface-2)]"
            aria-label="Clear search"
          >
            Clear
          </button>
        )}
      </div>

      {/* The two actionable lists sit side by side on a wide desktop, stacked
          otherwise (and always on mobile). */}
      <div className={isDesktop ? "grid gap-6 xl:grid-cols-2 xl:items-start" : "space-y-6"}>
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
                  onActivate={isDesktop ? () => onFocus(s.id) : undefined}
                  focused={isDesktop && focusedId === s.id}
                  right={
                    // stopPropagation so an action click doesn't also bubble to
                    // the row's desktop focus handler (mobile rows have no
                    // onActivate, so it's a harmless no-op there).
                    <div className="flex gap-2">
                      <button
                        type="button"
                        disabled={releasing.has(s.id)}
                        onClick={(e) => {
                          e.stopPropagation();
                          void releaseOne(s.id);
                        }}
                        className="btn btn-sm"
                      >
                        {releasing.has(s.id) ? "Releasing…" : "Release"}
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          onDeploy(s.id);
                        }}
                        className="btn btn-sm btn-primary"
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
                  showCheckbox={hasCrew}
                  selected={effectiveSelected.has(s.id)}
                  // Desktop: row focuses the preview, checkbox owns selection.
                  // Mobile: row toggles selection (the checkbox mirrors it).
                  onActivate={
                    isDesktop
                      ? () => onFocus(s.id)
                      : hasCrew
                        ? () => toggle(s.id)
                        : undefined
                  }
                  onCheckboxToggle={
                    isDesktop && hasCrew ? () => toggle(s.id) : undefined
                  }
                  focused={isDesktop && focusedId === s.id}
                  ariaPressed={
                    !isDesktop && hasCrew ? effectiveSelected.has(s.id) : undefined
                  }
                />
              ))}
            </ul>
          )}
        </section>
      </div>

      {/* Deployed (recent) + others' locks summary */}
      <section className="space-y-1 text-xs text-zinc-600">
        <p>Deployed: {buckets.deployed.length}</p>
        {buckets.othersClaimedCount > 0 && (
          <p>Claimed by other crews: {buckets.othersClaimedCount}</p>
        )}
      </section>

      {/* Sticky batch-claim action bar. `sticky` (not `fixed`) so it pins to the
          bottom of the shell's `.scroll` viewport — directly above the mobile tab
          bar and inside the desktop content column — instead of overlaying them.
          Pinning relies on no overflow/transform/filter ancestor between here and
          `.scroll` (see globals.css ~L885); keep this subtree free of them. */}
      {hasCrew && effectiveSelected.size > 0 && (
        <div className="sticky bottom-0 z-30 flex items-center justify-between gap-3 border-t border-[var(--line-strong)] bg-[var(--surface)] p-3">
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-sm text-zinc-400 hover:text-zinc-200"
          >
            Clear ({effectiveSelected.size})
          </button>
          <button
            type="button"
            disabled={claiming}
            onClick={claimSelected}
            className="btn btn-primary"
          >
            {claiming ? (
              "Claiming…"
            ) : (
              <>
                Claim {effectiveSelected.size} sign
                {effectiveSelected.size === 1 ? "" : "s"}
              </>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
