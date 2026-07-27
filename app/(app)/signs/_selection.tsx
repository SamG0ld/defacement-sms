"use client";

// The signs list's ONLY client-interactive surface: multi-select state + the
// bulk action bar. The table/cards themselves stay server-rendered and are
// passed through SelectionProvider as `children`; only the checkboxes
// (RowCheckbox / SelectAllHeader) and the BulkBar are client leaves that read
// this context. Selection is per-page and resets on navigation/revalidate — the
// "select all N matching" toggle is what reaches beyond the current page.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { usePresence } from "@/app/_components/usePresence";

import { SIGN_FORMATS } from "@/lib/sign-format";

import {
  ARCHIVED_STATUS,
  DEPLOYMENT_SLOTS,
  SIGN_STATUSES,
  statusBadgeClass,
} from "./_lib";
import {
  bulkAddTag,
  bulkDelete,
  bulkRemoveTag,
  bulkSetFormat,
  bulkSetHardwareCollected,
  bulkSetHardwareReturned,
  bulkSetSlot,
  bulkSetStatus,
  bulkSetZone,
} from "./bulk-actions";
import { bulkArchive, bulkRestore } from "./remove-actions";
import { generateSelection } from "./generate-actions";

type SelectionContextValue = {
  selected: Set<number>;
  allMatching: boolean;
  total: number;
  pageIds: number[];
  toggle: (id: number) => void;
  toggleAllOnPage: () => void;
  setAllMatching: (v: boolean) => void;
  clear: () => void;
};

const SelectionContext = createContext<SelectionContextValue | null>(null);

function useSelection(): SelectionContextValue {
  const ctx = useContext(SelectionContext);
  if (!ctx) throw new Error("useSelection must be used within SelectionProvider");
  return ctx;
}

export function SelectionProvider({
  pageIds,
  total,
  children,
}: {
  pageIds: number[];
  total: number;
  children: React.ReactNode;
}) {
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [allMatching, setAllMatching] = useState(false);

  const toggle = useCallback((id: number) => {
    setAllMatching(false);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleAllOnPage = useCallback(() => {
    setAllMatching(false);
    setSelected((prev) => {
      const allOn = pageIds.length > 0 && pageIds.every((id) => prev.has(id));
      if (allOn) return new Set();
      return new Set(pageIds);
    });
  }, [pageIds]);

  const clear = useCallback(() => {
    setAllMatching(false);
    setSelected(new Set());
  }, []);

  const value = useMemo(
    () => ({
      selected,
      allMatching,
      total,
      pageIds,
      toggle,
      toggleAllOnPage,
      setAllMatching,
      clear,
    }),
    [selected, allMatching, total, pageIds, toggle, toggleAllOnPage, clear],
  );

  return (
    <SelectionContext.Provider value={value}>
      {children}
    </SelectionContext.Provider>
  );
}

export function RowCheckbox({ signId }: { signId: number }) {
  const { selected, allMatching, toggle } = useSelection();
  const checked = allMatching || selected.has(signId);
  return (
    <input
      type="checkbox"
      aria-label={`Select sign ${signId}`}
      checked={checked}
      disabled={allMatching}
      onChange={() => toggle(signId)}
      className="h-4 w-4 cursor-pointer accent-[var(--brand)]"
    />
  );
}

export function SelectAllHeader() {
  const { selected, allMatching, pageIds, toggleAllOnPage } = useSelection();
  const ref = useRef<HTMLInputElement>(null);
  const onPage = pageIds.filter((id) => selected.has(id)).length;
  const allOn = allMatching || (pageIds.length > 0 && onPage === pageIds.length);
  const someOn = !allOn && onPage > 0;

  useEffect(() => {
    if (ref.current) ref.current.indeterminate = someOn;
  }, [someOn]);

  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select all on this page"
      checked={allOn}
      onChange={toggleAllOnPage}
      className="h-4 w-4 cursor-pointer accent-[var(--brand)]"
    />
  );
}

// Hidden inputs that tell a bulk action WHICH signs to act on: either the
// explicit selected-id list, or "all matching the current filter".
function SelectionInputs({
  filters,
  returnTo,
}: {
  filters: Record<string, string>;
  returnTo: string;
}) {
  const { selected, allMatching } = useSelection();
  return (
    <>
      <input type="hidden" name="returnTo" value={returnTo} />
      {allMatching ? (
        <>
          <input type="hidden" name="allMatching" value="1" />
          {Object.entries(filters)
            .filter(([, v]) => v)
            .map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
        </>
      ) : (
        <input type="hidden" name="ids" value={JSON.stringify([...selected])} />
      )}
    </>
  );
}

// Console primitives, compact for the dense bulk bar.
const FIELD = "field text-xs";
const ACTION_BTN = "btn btn-sm disabled:opacity-40";

export function BulkBar({
  canManage,
  filters,
  returnTo,
  zones,
  tags,
}: {
  canManage: boolean;
  filters: Record<string, string>;
  returnTo: string;
  zones: { id: number; label: string }[];
  tags: { id: number; name: string }[];
}) {
  const { selected, allMatching, total, pageIds, setAllMatching, clear } =
    useSelection();
  const count = allMatching ? total : selected.size;
  // The "Removed" view (?status=archived) swaps Remove for Restore.
  const onArchivedView = filters.status === ARCHIVED_STATUS;

  // Slide in/out instead of snapping: usePresence keeps the bar mounted through
  // its exit animation (hooks must run before the early return below).
  const present = count > 0;
  const { rendered, exiting, onAnimationEnd } = usePresence(present);
  // Freeze the headline count for the slide-out frames so it doesn't blink to 0
  // (count is already 0 during the exit). Render-phase state adjustment — the
  // same "derive state from a changing value" pattern usePresence uses; only
  // advances while count > 0, so it holds the last real value through the exit.
  const [shownCount, setShownCount] = useState(count);
  const [prevCount, setPrevCount] = useState(count);
  if (count !== prevCount) {
    setPrevCount(count);
    if (count > 0) setShownCount(count);
  }

  if (!rendered) return null;

  const pageFull = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const canOfferAll = !allMatching && pageFull && total > pageIds.length;
  const inputs = <SelectionInputs filters={filters} returnTo={returnTo} />;

  return (
    <div
      className="bulkbar sticky bottom-0 z-10 -mx-4 border-t border-[var(--line-strong)] bg-[var(--surface)] px-4 py-3"
      data-exiting={exiting ? "" : undefined}
      onAnimationEnd={onAnimationEnd}
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2 text-sm text-zinc-300">
          <span className="font-medium text-accent">{shownCount}</span>
          <span>selected</span>
          <button
            type="button"
            onClick={clear}
            className="text-xs text-zinc-500 underline hover:text-zinc-300"
          >
            clear
          </button>
        </div>

        {canOfferAll && (
          <button
            type="button"
            onClick={() => setAllMatching(true)}
            className="text-xs text-accent underline hover:opacity-80"
          >
            Select all {total} matching this filter
          </button>
        )}

        {/* Status + hardware are meaningless on removed signs — and Set-status
            would be an un-archive bypass — so they're hidden on the Removed
            view, where Restore/Delete are the only actions. */}
        {!onArchivedView && (
          <>
        {/* Status — any active user */}
        <form action={bulkSetStatus} className="flex items-center gap-1">
          {inputs}
          <span className="text-xs text-zinc-500">Set:</span>
          {SIGN_STATUSES.map((s) => (
            <button
              key={s}
              type="submit"
              name="setStatus"
              value={s}
              className={`badge ${statusBadgeClass(s)} cursor-pointer hover:opacity-80`}
            >
              {s}
            </button>
          ))}
        </form>

        {/* Hardware collected — any active user */}
        <form action={bulkSetHardwareCollected} className="flex items-center gap-1">
          {inputs}
          <input type="hidden" name="collected" value="1" />
          <button
            type="submit"
            className={ACTION_BTN}
            title="Mark hardware collected for the selection"
          >
            Mark HW ✓
          </button>
        </form>

        {/* Hardware returned — any active user (strike-time mirror) */}
        <form action={bulkSetHardwareReturned} className="flex items-center gap-1">
          {inputs}
          <input type="hidden" name="returned" value="1" />
          <button
            type="submit"
            className={ACTION_BTN}
            title="Mark hardware returned for the selection"
          >
            Mark returned
          </button>
        </form>
          </>
        )}

        {canManage && (
          <>
            {/* Restore — un-remove the selected archived signs back to the
                per-size record. Only on the Removed view (?status=archived). */}
            {onArchivedView && (
              <form action={bulkRestore} className="flex items-center gap-1">
                {inputs}
                <button
                  type="submit"
                  className="btn btn-sm btn-primary"
                  title="Restore the selected removed signs to the per-size record"
                >
                  Restore
                </button>
              </form>
            )}

            {/* Lifecycle bulk edits don't apply to removed signs (and Generate
                would un-archive them) — hidden on the Removed view, where
                Restore + Delete are the only actions. */}
            {!onArchivedView && (
              <>
            {/* Generate — create a tracked batch from the selection (marks the
                signs generated + hands off the render-ready list to Figma) */}
            <form action={generateSelection}>
              {inputs}
              <button
                type="submit"
                className={ACTION_BTN}
                title="Create a generation batch from the selection (marks them generated)"
              >
                Generate
              </button>
            </form>

            {/* Set format — the batch resize. One choice re-derives
                size/type/category/double-sided across the whole selection. */}
            <form action={bulkSetFormat} className="flex items-center gap-1">
              {inputs}
              <select name="setFormat" defaultValue="" className={FIELD} required>
                <option value="" disabled>
                  format…
                </option>
                {SIGN_FORMATS.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </select>
              <button type="submit" className={ACTION_BTN}>
                Set format
              </button>
            </form>

            {/* Zone */}
            <form action={bulkSetZone} className="flex items-center gap-1">
              {inputs}
              <select name="zoneId" defaultValue="" className={FIELD} required>
                <option value="" disabled>
                  zone…
                </option>
                {zones.map((z) => (
                  <option key={z.id} value={z.id}>
                    {z.label}
                  </option>
                ))}
              </select>
              <button type="submit" className={ACTION_BTN}>
                Set zone
              </button>
            </form>

            {/* Slot ("" clears it) */}
            <form action={bulkSetSlot} className="flex items-center gap-1">
              {inputs}
              <select name="setSlot" defaultValue="" className={FIELD}>
                <option value="">no slot</option>
                {DEPLOYMENT_SLOTS.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
              <button type="submit" className={ACTION_BTN}>
                Set slot
              </button>
            </form>

            {/* Tag add / remove */}
            <form action={bulkAddTag} className="flex items-center gap-1">
              {inputs}
              <select name="tagId" defaultValue="" className={FIELD} required>
                <option value="" disabled>
                  tag…
                </option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              <button type="submit" className={ACTION_BTN}>
                Add
              </button>
              <button type="submit" formAction={bulkRemoveTag} className={ACTION_BTN}>
                Remove
              </button>
            </form>
              </>
            )}

            {/* Delete */}
            <form
              action={bulkDelete}
              onSubmit={(e) => {
                if (
                  !confirm(`Delete ${shownCount} sign(s)? This cannot be undone.`)
                ) {
                  e.preventDefault();
                }
              }}
            >
              {inputs}
              <button type="submit" className="btn btn-sm btn-danger">
                Delete
              </button>
            </form>

            {/* Remove — soft-remove the selection from the per-size record
                (reversible; pending/generated only). Hidden on the Removed
                view, where Restore takes its place. */}
            {!onArchivedView && (
              <form
                action={bulkArchive}
                onSubmit={(e) => {
                  if (
                    !confirm(
                      `Remove ${shownCount} sign(s) from the per-size record?\n\n` +
                        `Only not-yet-printed signs are removed; already-printed ` +
                        `signs are skipped. You can restore removed signs from ` +
                        `the Removed view.`,
                    )
                  ) {
                    e.preventDefault();
                  }
                }}
              >
                {inputs}
                <button
                  type="submit"
                  className="btn btn-sm border-amber-700 text-amber-300 hover:bg-amber-950"
                  title="Soft-remove the selection from the per-size record (reversible)"
                >
                  Remove
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
