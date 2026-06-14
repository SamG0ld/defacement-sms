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
        <button type="submit" className="btn btn-sm">
          {isActive ? "Deactivate" : "Reactivate"}
        </button>
      </form>

      {confirming ? (
        <div className="flex items-center gap-1.5">
          <form action={removeUser.bind(null, userId)}>
            <button type="submit" className="btn btn-danger btn-sm">
              Confirm remove
            </button>
          </form>
          <button
            type="button"
            onClick={() => setConfirming(false)}
            className="px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="btn btn-sm"
        >
          Remove
        </button>
      )}
    </div>
  );
}
