"use client";

import { useState } from "react";

import { removeUser, setUserActive } from "../actions";

// Per-row account controls. Deactivate is the soft (reversible, kill-switch)
// path; Remove is a hard delete behind a two-step click-then-confirm so it can't
// be fired by a stray click. Only rendered for other users (the page hides this
// for the self row), so no self-guard is needed here — the actions re-check
// server-side regardless.
export function UserRowActions({
  userId,
  isActive,
}: {
  userId: string;
  isActive: boolean;
}) {
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="flex items-center justify-end gap-2">
      <form action={setUserActive.bind(null, userId, !isActive)}>
        <button
          type="submit"
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          {isActive ? "Deactivate" : "Reactivate"}
        </button>
      </form>

      {confirming ? (
        <div className="flex items-center gap-1">
          <form action={removeUser.bind(null, userId)}>
            <button
              type="submit"
              className="rounded border border-red-800 bg-red-950 px-2 py-1 text-xs text-red-200 hover:bg-red-900"
            >
              Confirm remove
            </button>
          </form>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="rounded px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-red-300"
        >
          Remove
        </button>
      )}
    </div>
  );
}
