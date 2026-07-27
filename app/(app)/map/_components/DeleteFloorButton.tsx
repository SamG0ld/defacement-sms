"use client";

import { deleteFloorMap } from "../actions";

// Permanently delete a floor map, gated behind a confirm — unlike disable, this
// removes the row + image and can't be undone. A server-component <form> can't
// carry an onSubmit handler, so this small client island wraps the server action
// and warns how many sign pins will be orphaned (matches the confirm pattern in
// signs/_selection.tsx).
export function DeleteFloorButton({
  id,
  label,
  pinnedSignCount,
}: {
  id: number;
  label: string;
  pinnedSignCount: number;
}) {
  const warning =
    pinnedSignCount > 0
      ? `Delete "${label}"?\n\n${pinnedSignCount} sign pin(s) on this floor will become unplaced. This can't be undone.`
      : `Delete "${label}"? This can't be undone.`;
  return (
    <form
      action={deleteFloorMap}
      onSubmit={(e) => {
        if (!confirm(warning)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <button type="submit" className="btn btn-sm btn-danger">
        Delete
      </button>
    </form>
  );
}
