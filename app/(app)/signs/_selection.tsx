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

import { DEPLOYMENT_SLOTS, SIGN_STATUSES, statusBadgeClass } from "./_lib";
import {
  bulkAddTag,
  bulkDelete,
  bulkRemoveTag,
  bulkSetHardwareCollected,
  bulkSetSlot,
  bulkSetStatus,
  bulkSetZone,
} from "./bulk-actions";

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

const FIELD =
  "rounded border border-zinc-700 bg-black px-2 py-1 text-xs text-zinc-100";
const ACTION_BTN =
  "rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-200 hover:bg-zinc-800 disabled:opacity-40";

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
  if (count === 0) return null;

  const pageFull = pageIds.length > 0 && pageIds.every((id) => selected.has(id));
  const canOfferAll = !allMatching && pageFull && total > pageIds.length;
  const inputs = <SelectionInputs filters={filters} returnTo={returnTo} />;

  return (
    <div className="sticky bottom-0 z-10 -mx-4 border-t border-zinc-800 bg-zinc-950/95 px-4 py-3 backdrop-blur">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-2 text-sm text-zinc-300">
          <span className="font-medium text-accent">{count}</span>
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
              className={`rounded border px-2 py-0.5 text-[10px] uppercase ${statusBadgeClass(s)} hover:opacity-80`}
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

        {canManage && (
          <>
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

            {/* Delete */}
            <form
              action={bulkDelete}
              onSubmit={(e) => {
                if (!confirm(`Delete ${count} sign(s)? This cannot be undone.`)) {
                  e.preventDefault();
                }
              }}
            >
              {inputs}
              <button
                type="submit"
                className="rounded border border-red-900 px-2 py-1 text-xs text-red-300 hover:bg-red-950"
              >
                Delete
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
