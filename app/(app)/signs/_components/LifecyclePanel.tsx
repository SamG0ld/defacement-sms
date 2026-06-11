// External-item lifecycle panel (Phase 2). Shown only for union_installed /
// ops_map signs — the classes we don't deploy ourselves. Walks the chain of
// custody: accept delivery from the print shop → hand off to a union crew / ops
// team → confirm installed. The "current action" is driven by which stamps exist
// (deliveredAt / handedOffAt / installedAt), not by raw status, so it stays correct
// even if status was jumped via the generic dropdown. Proof photos are streamed
// through the auth-gated /api/photos/sign route (never world-readable).
import type { SignCategory, SignStatus } from "@/app/generated/prisma/enums";

import {
  confirmInstalled,
  recordDelivery,
  recordHandoff,
} from "../lifecycle-actions";
import { formatDateTime, isExternalCategory } from "../_lib";

type LifecycleSign = {
  id: number;
  status: SignStatus;
  category: SignCategory;
  quantity: number;
  deliveredBy: string | null;
  deliveredAt: Date | null;
  receivedQty: number | null;
  deliveryCondition: string | null;
  deliveryPhotoUrl: string | null;
  handedOffTo: string | null;
  handedOffBy: string | null;
  handedOffAt: Date | null;
  handoffNotes: string | null;
  handoffPhotoUrl: string | null;
  installedBy: string | null;
  installedAt: Date | null;
  installNotes: string | null;
  installPhotoUrl: string | null;
};

const inputClass =
  "rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600";
const labelClass = "flex flex-col gap-1 text-xs text-zinc-400";

function Stamp({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="text-sm text-zinc-200">{value}</dd>
    </div>
  );
}

function PhotoThumb({ src, alt }: { src: string; alt: string }) {
  return (
    <a href={src} target="_blank" rel="noopener noreferrer">
      {/* eslint-disable-next-line @next/next/no-img-element -- private auth-gated blob, not a static asset */}
      <img
        src={src}
        alt={alt}
        className="h-16 w-16 rounded border border-zinc-700 object-cover hover:border-zinc-500"
      />
    </a>
  );
}

export function LifecyclePanel({ sign }: { sign: LifecycleSign }) {
  if (!isExternalCategory(sign.category)) return null;

  const installer = sign.category === "ops_map" ? "ops team" : "union crew";
  const stage = sign.installedAt
    ? "done"
    : sign.handedOffAt
      ? "install"
      : sign.deliveredAt
        ? "handoff"
        : "delivery";

  return (
    <section className="space-y-4 rounded-lg border border-amber-900/60 bg-amber-950/10 p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-amber-200">
          External item — delivery &amp; handoff
        </h2>
        <span className="text-xs text-zinc-500">
          produced off-site · installed by {installer}
        </span>
      </div>

      {/* Read-back of progress so far (each block guarded by its timestamp). Note:
          deliveredAt is also set by a plain status change to "delivered" via the
          generic dropdown, so this block can appear with qty/condition null if the
          delivery wasn't recorded through the form above. */}
      <dl className="grid gap-3 sm:grid-cols-3">
        {sign.deliveredAt && (
          <div className="space-y-2 rounded border border-zinc-800 bg-zinc-950 p-3">
            <Stamp
              label="Delivery received"
              value={`${sign.receivedQty ?? "—"} of ${sign.quantity}`}
            />
            <Stamp label="By" value={sign.deliveredBy ?? "—"} />
            <Stamp label="At" value={formatDateTime(sign.deliveredAt)} />
            {sign.deliveryCondition && (
              <Stamp label="Condition" value={sign.deliveryCondition} />
            )}
            {sign.deliveryPhotoUrl && (
              <PhotoThumb
                src={`/api/photos/sign/${sign.id}/delivery`}
                alt="Delivery condition photo"
              />
            )}
          </div>
        )}
        {sign.handedOffAt && (
          <div className="space-y-2 rounded border border-zinc-800 bg-zinc-950 p-3">
            <Stamp label="Handed off to" value={sign.handedOffTo ?? "—"} />
            <Stamp label="By" value={sign.handedOffBy ?? "—"} />
            <Stamp label="At" value={formatDateTime(sign.handedOffAt)} />
            {sign.handoffNotes && (
              <Stamp label="Notes" value={sign.handoffNotes} />
            )}
            {sign.handoffPhotoUrl && (
              <PhotoThumb
                src={`/api/photos/sign/${sign.id}/handoff`}
                alt="Handoff photo"
              />
            )}
          </div>
        )}
        {sign.installedAt && (
          <div className="space-y-2 rounded border border-zinc-800 bg-zinc-950 p-3">
            <Stamp label="Installed" value="✓ confirmed" />
            <Stamp label="By" value={sign.installedBy ?? "—"} />
            <Stamp label="At" value={formatDateTime(sign.installedAt)} />
            {sign.installNotes && (
              <Stamp label="Notes" value={sign.installNotes} />
            )}
            {sign.installPhotoUrl && (
              <PhotoThumb
                src={`/api/photos/sign/${sign.id}/install`}
                alt="Install photo"
              />
            )}
          </div>
        )}
      </dl>

      {/* The current action. */}
      {stage === "delivery" && (
        <form
          action={recordDelivery.bind(null, sign.id)}
          className="flex flex-wrap items-end gap-3 border-t border-zinc-800 pt-4"
        >
          <p className="w-full text-xs font-medium text-amber-200">
            Accept delivery from the print shop
          </p>
          <label className={labelClass}>
            Received qty
            <input
              type="number"
              name="receivedQty"
              min={0}
              placeholder={String(sign.quantity)}
              className={`${inputClass} w-28`}
            />
          </label>
          <label className={`${labelClass} flex-1`}>
            Condition (optional)
            <input
              type="text"
              name="condition"
              placeholder="e.g. 2 of 5 arrived creased"
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Photo (optional)
            <input
              type="file"
              name="photo"
              accept="image/png,image/jpeg,image/webp"
              className="text-xs text-zinc-400"
            />
          </label>
          <button
            type="submit"
            className="btn-primary rounded px-3 py-1.5 text-sm font-medium"
          >
            Record delivery
          </button>
        </form>
      )}

      {stage === "handoff" && (
        <form
          action={recordHandoff.bind(null, sign.id)}
          className="flex flex-wrap items-end gap-3 border-t border-zinc-800 pt-4"
        >
          <p className="w-full text-xs font-medium text-amber-200">
            Hand off to the {installer}
          </p>
          <label className={`${labelClass} flex-1`}>
            Recipient *
            <input
              type="text"
              name="handedOffTo"
              required
              placeholder={
                sign.category === "ops_map"
                  ? "e.g. NOC dispatch"
                  : "e.g. Union Local 720 — Mike"
              }
              className={inputClass}
            />
          </label>
          <label className={`${labelClass} flex-1`}>
            Notes (optional)
            <input type="text" name="notes" className={inputClass} />
          </label>
          <label className={labelClass}>
            Photo (optional)
            <input
              type="file"
              name="photo"
              accept="image/png,image/jpeg,image/webp"
              className="text-xs text-zinc-400"
            />
          </label>
          <button
            type="submit"
            className="btn-primary rounded px-3 py-1.5 text-sm font-medium"
          >
            Record handoff
          </button>
        </form>
      )}

      {stage === "install" && (
        <form
          action={confirmInstalled.bind(null, sign.id)}
          className="flex flex-wrap items-end gap-3 border-t border-zinc-800 pt-4"
        >
          <p className="w-full text-xs font-medium text-amber-200">
            Confirm the item was installed
          </p>
          <label className={`${labelClass} flex-1`}>
            Notes (optional)
            <input
              type="text"
              name="notes"
              placeholder="e.g. confirmed up on the SE wall"
              className={inputClass}
            />
          </label>
          <label className={labelClass}>
            Photo (optional)
            <input
              type="file"
              name="photo"
              accept="image/png,image/jpeg,image/webp"
              className="text-xs text-zinc-400"
            />
          </label>
          <button
            type="submit"
            className="btn-primary rounded px-3 py-1.5 text-sm font-medium"
          >
            Confirm installed
          </button>
        </form>
      )}

      {stage === "done" && (
        <p className="border-t border-zinc-800 pt-4 text-xs text-zinc-400">
          Lifecycle complete — delivered, handed off, and installed.
        </p>
      )}
    </section>
  );
}
