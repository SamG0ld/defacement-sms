import Link from "next/link";

import { ARCHIVED_STATUS, SIGN_STATUSES, statusLabel } from "../_lib";

// Status filter as a horizontal chip row (replaces the status <select>). Each chip
// is a real <Link> that sets ?status=<s> (or clears it for "All") via the
// page-supplied hrefForStatus, so filtering is plain server-rendered navigation —
// no client island. The active chip tints to its own status color (see globals
// .chip.active[data-s]). Counts are the per-stage totals within the other active
// filters, computed once on the server.
export function FilterChips({
  active,
  counts,
  total,
  archivedCount,
  hrefForStatus,
}: {
  active: string;
  counts: Record<string, number>;
  total: number;
  archivedCount: number;
  hrefForStatus: (status: string) => string;
}) {
  // Plain navigation links (not an ARIA tablist — these rerender the page rather
  // than toggling tabpanels). aria-current marks the active filter.
  return (
    <nav className="chiprow" aria-label="Filter by status">
      <Link
        href={hrefForStatus("")}
        aria-current={!active ? "page" : undefined}
        className={"chip" + (!active ? " active" : "")}
      >
        All <span className="ct">{total}</span>
      </Link>
      {SIGN_STATUSES.map((s) => (
        <Link
          key={s}
          href={hrefForStatus(s)}
          data-s={s}
          aria-current={active === s ? "page" : undefined}
          className={"chip" + (active === s ? " active" : "")}
        >
          {statusLabel(s)} <span className="ct">{counts[s] ?? 0}</span>
        </Link>
      ))}
      {/* Soft-removed signs live off the lifecycle track. Surface a "Removed"
          chip only when there ARE any (or you're already viewing them), so it
          stays out of the way until removal has been used. */}
      {(archivedCount > 0 || active === ARCHIVED_STATUS) && (
        <Link
          href={hrefForStatus(ARCHIVED_STATUS)}
          data-s={ARCHIVED_STATUS}
          aria-current={active === ARCHIVED_STATUS ? "page" : undefined}
          className={"chip" + (active === ARCHIVED_STATUS ? " active" : "")}
        >
          {statusLabel(ARCHIVED_STATUS)}{" "}
          <span className="ct">{archivedCount}</span>
        </Link>
      )}
    </nav>
  );
}
