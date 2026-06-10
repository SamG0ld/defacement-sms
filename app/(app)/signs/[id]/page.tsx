import Link from "next/link";
import { notFound } from "next/navigation";

import { getSession } from "@/lib/session";
import { prisma } from "@/lib/db";
import { hasRole } from "@/lib/rbac";

import { WhereItGoes } from "../../map/_components/WhereItGoes";

import {
  deleteSign,
  setHardwareCollected,
  updateSignStatus,
} from "../actions";
import {
  SIGN_STATUSES,
  deploymentSlotLabel,
  formatDate,
  formatDateOnly,
  formatDateTime,
  hardwareKind,
  needsHardware,
  safeColor,
  shortZoneLabel,
  statusBadgeClass,
} from "../_lib";

type Params = Promise<{ id: string }>;
type SearchParams = Promise<{ error?: string }>;

function money(v: { toString(): string } | null): string {
  if (v == null) return "—";
  const n = Number(v.toString());
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : "—";
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-0.5">
      <dt className="text-xs uppercase tracking-wide text-zinc-500">{label}</dt>
      <dd className="text-sm text-zinc-200">{children}</dd>
    </div>
  );
}

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
      <h2 className="text-sm font-semibold text-zinc-300">{title}</h2>
      <dl className="grid grid-cols-2 gap-3">{children}</dl>
    </section>
  );
}

export default async function SignDetailPage({
  params,
  searchParams,
}: {
  params: Params;
  searchParams: SearchParams;
}) {
  const { id } = await params;
  const signId = Number.parseInt(id, 10);
  if (!Number.isInteger(signId)) notFound();

  const { error } = await searchParams;

  const session = await getSession();
  const canManage = session?.user?.role
    ? hasRole(session.user.role, "lead")
    : false;

  const sign = await prisma.sign.findUnique({
    where: { id: signId },
    include: {
      zone: true,
      location: { include: { zone: true, floorMap: { select: { key: true } } } },
      tagAssignments: { include: { tag: true } },
      statusHistory: { orderBy: { changedAt: "desc" } },
    },
  });
  if (!sign) notFound();

  // Any status other than the current one can be set directly (jump-to-any).
  const next = SIGN_STATUSES.filter((s) => s !== sign.status);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <Link
            href="/signs"
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            ← All signs
          </Link>
          <h1 className="text-2xl font-semibold">{sign.signText}</h1>
          <p className="font-mono text-sm text-zinc-500">
            {sign.itemId} · {sign.signType} · {sign.size}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`rounded border px-2.5 py-1 text-xs uppercase ${statusBadgeClass(sign.status)}`}
          >
            {sign.status}
          </span>
          {canManage && (
            <>
              <Link
                href={`/signs/${sign.id}/edit`}
                className="rounded border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                Edit
              </Link>
              <form action={deleteSign.bind(null, sign.id)}>
                <button
                  type="submit"
                  className="rounded border border-red-900 px-3 py-1 text-sm text-red-300 hover:bg-red-950"
                >
                  Delete
                </button>
              </form>
            </>
          )}
        </div>
      </div>

      {error && (
        <div className="rounded border border-red-900 bg-red-950 px-3 py-2 text-xs text-red-200">
          {error}
        </div>
      )}

      {/* Status update control */}
      <section className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <h2 className="text-sm font-semibold text-zinc-300">Update status</h2>
        {next.length === 0 ? (
          <p className="text-xs text-zinc-500">No further transitions.</p>
        ) : (
          <form
            action={updateSignStatus.bind(null, sign.id)}
            className="flex flex-wrap items-end gap-3"
          >
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              New status
              <select
                name="status"
                defaultValue=""
                required
                className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100"
              >
                <option value="" disabled>
                  choose…
                </option>
                {next.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-1 flex-col gap-1 text-xs text-zinc-400">
              Note (optional)
              <input
                type="text"
                name="notes"
                placeholder="e.g. handed off to deploy team"
                className="rounded border border-zinc-700 bg-black px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600"
              />
            </label>
            <button
              type="submit"
              className="btn-primary rounded px-3 py-1.5 text-sm font-medium"
            >
              Update
            </button>
          </form>
        )}
      </section>

      <WhereItGoes sign={sign} canManage={canManage} />

      <div className="grid gap-4 md:grid-cols-2">
        <Panel title="Identity">
          <Field label="Item ID">{sign.itemId}</Field>
          <Field label="Type">{sign.signType}</Field>
          <Field label="Size">{sign.size}</Field>
          <Field label="Quantity">{sign.quantity}</Field>
          <Field label="Double-sided">{sign.doubleSided ? "Yes" : "No"}</Field>
          <Field label="Needs easel">{sign.needsEasel ? "Yes" : "No"}</Field>
        </Panel>

        <Panel title="Placement & scheduling">
          <Field label="Zone">
            {shortZoneLabel(sign.zone)}
          </Field>
          <Field label="Priority">{sign.deploymentPriority}</Field>
          <Field label="Placement area">{sign.placementArea ?? "—"}</Field>
          <Field label="Exact destination">
            {sign.exactDestination ?? "—"}
          </Field>
          <Field label="Deploy slot">
            {deploymentSlotLabel(sign.deploymentSlot)}
          </Field>
          <Field label="Deploy by">{formatDateOnly(sign.deployByDate)}</Field>
        </Panel>

        <Panel title="Request & cost">
          <Field label="Requestor">{sign.requestor ?? "—"}</Field>
          <Field label="Requestor email">{sign.requestorEmail ?? "—"}</Field>
          <Field label="Cost / unit">{money(sign.costPerUnit)}</Field>
          <Field label="Total cost">{money(sign.totalCost)}</Field>
          <Field label="Requested">{formatDate(sign.requestDate)}</Field>
        </Panel>

        <Panel title="Delivery & deployment">
          <Field label="Delivered by">{sign.deliveredBy ?? "—"}</Field>
          <Field label="Delivered at">{formatDateTime(sign.deliveredAt)}</Field>
          <Field label="Deployed by">{sign.deployedBy ?? "—"}</Field>
          <Field label="Deployed at">{formatDateTime(sign.deployedAt)}</Field>
          <Field label="Deployment notes">
            {sign.deploymentNotes ?? "—"}
          </Field>
          {needsHardware(sign) && (
            <Field label={`Hardware (${hardwareKind(sign)})`}>
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`rounded border px-2 py-0.5 text-[10px] uppercase ${
                    sign.equipmentCheckedOut
                      ? "border-[var(--accent)] text-accent"
                      : "border-zinc-700 text-zinc-400"
                  }`}
                >
                  {sign.equipmentCheckedOut ? "collected" : "not collected"}
                </span>
                <form
                  action={setHardwareCollected.bind(null, sign.id)}
                  className="inline"
                >
                  <input
                    type="hidden"
                    name="collected"
                    value={sign.equipmentCheckedOut ? "0" : "1"}
                  />
                  <button
                    type="submit"
                    className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    {sign.equipmentCheckedOut
                      ? "mark not collected"
                      : "mark collected"}
                  </button>
                </form>
              </div>
            </Field>
          )}
        </Panel>
      </div>

      {/* Tags + notes */}
      <section className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <h2 className="text-sm font-semibold text-zinc-300">Tags & notes</h2>
        <div className="flex flex-wrap gap-1">
          {sign.tagAssignments.length === 0 ? (
            <span className="text-sm text-zinc-500">No tags.</span>
          ) : (
            sign.tagAssignments.map((a) => (
              <span
                key={a.tagId}
                className="rounded border px-2 py-0.5 text-xs text-zinc-200"
                style={{ borderColor: safeColor(a.tag.color) }}
              >
                {a.tag.name}
              </span>
            ))
          )}
        </div>
        {sign.notes && (
          <p className="whitespace-pre-wrap text-sm text-zinc-300">
            {sign.notes}
          </p>
        )}
      </section>

      {/* Status history timeline */}
      <section className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-950 p-4">
        <h2 className="text-sm font-semibold text-zinc-300">Status history</h2>
        {sign.statusHistory.length === 0 ? (
          <p className="text-sm text-zinc-500">No status changes yet.</p>
        ) : (
          <ol className="space-y-2">
            {sign.statusHistory.map((h) => (
              <li
                key={h.id}
                className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-l-2 border-zinc-800 pl-3 text-sm"
              >
                <span className="text-zinc-200">
                  {h.oldStatus ? `${h.oldStatus} → ` : ""}
                  {h.newStatus}
                </span>
                <span className="text-xs text-zinc-500">
                  {formatDateTime(h.changedAt)}
                </span>
                {h.changedBy && (
                  <span className="text-xs text-zinc-500">
                    · {h.changedBy}
                  </span>
                )}
                {h.notes && (
                  <span className="w-full text-xs text-zinc-400">
                    {h.notes}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
