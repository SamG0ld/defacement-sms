// Shared, server-safe constants + helpers for the signs domain UI.
// No "use client" / no React here — imported by pages and Server Actions alike.
import type {
  Prisma,
  SignCategory,
  SignStatus,
} from "@/app/generated/prisma/client";
import { SIGN_FORM_TYPES } from "@/lib/print-summary";

// Canonical workflow order. Kept as a plain tuple (not the Prisma enum object)
// so it can drive ordered UI and ranking (stampsForStatus) without depending on
// enum key iteration order. This IS the source of truth for order — the Postgres
// enum's internal order does NOT match it (new values were added with
// `ALTER TYPE ADD VALUE`, which appends), so never `ORDER BY status` in SQL;
// order/rank via this array's index instead.
export const SIGN_STATUSES = [
  "pending",
  "generated",
  "printed",
  "delivered",
  "sorted",
  "deployed",
  // External-item terminal path (Phase 2): union_installed / ops_map signs branch
  // off after `delivered` into handed_off → installed instead of sorted → deployed.
  // Kept after deployed so the existing delivered/deployed ranks are unchanged.
  "handed_off",
  "installed",
] as const satisfies readonly SignStatus[];

// Item-class vocabulary for the form <select> and the list filter. Distinct classes
// count + need hardware differently (see lib/print-summary). Order is display order.
export const SIGN_CATEGORIES = [
  "easel_sign",
  "meterboard",
  "socks",
  "ops_map",
  "union_installed",
  "other",
] as const satisfies readonly SignCategory[];

export const SIGN_CATEGORY_LABELS: Record<SignCategory, string> = {
  easel_sign: "Easel sign (22×28 / 24×36)",
  meterboard: "Meterboard (4×8)",
  socks: "Socks (21×42 flying)",
  ops_map: "Ops / venue map (paper)",
  union_installed: "Union-installed (banner / graphic)",
  other: "Other / unclassified",
};

// Categories produced off-site and installed by an external actor (union crew /
// ops team). These follow the delivered → handed_off → installed lifecycle
// (lifecycle-actions.ts) instead of our own sorted → deployed flow, and are the
// only categories for which the LifecyclePanel + lifecycle actions apply.
export const EXTERNAL_CATEGORIES = [
  "union_installed",
  "ops_map",
] as const satisfies readonly SignCategory[];

export function isExternalCategory(category: SignCategory): boolean {
  return (EXTERNAL_CATEGORIES as readonly SignCategory[]).includes(category);
}

// Note: the old step-wise VALID_TRANSITIONS / allowedNextStatuses / isValidTransition
// were removed when status changes became direct jump-to-any (a sign can be set
// to any status from any status). updateSignStatus + bulkSetStatus only reject a
// no-op (same status) now; stampsForStatus keeps the delivery/deploy timestamps
// consistent regardless of the jump distance.

// Shared filter → Prisma where, used by both the list page and the CSV export
// so the two always agree on what "the current view" means.
export type SignFilters = {
  status?: string;
  zone?: string;
  tag?: string;
  slot?: string;
  type?: string;
  category?: string;
  q?: string;
  // Deploy-by urgency, used by the dashboard quick-links. "today" = due on the
  // current Vegas date; "overdue" = due before today. Both imply "not yet
  // deployed". Composed via AND so they never clobber an explicit status filter.
  due?: string;
};

export function buildSignWhere(f: SignFilters): Prisma.SignWhereInput {
  const where: Prisma.SignWhereInput = {};
  if (f.status && SIGN_STATUSES.includes(f.status as SignStatus)) {
    where.status = f.status as SignStatus;
  }
  if (f.zone) {
    const zoneId = Number.parseInt(f.zone, 10);
    if (Number.isInteger(zoneId) && zoneId > 0) where.zoneId = zoneId;
  }
  if (f.tag) where.tagAssignments = { some: { tag: { slug: f.tag } } };
  if (f.slot) where.deploymentSlot = f.slot;
  if (f.type) where.signType = f.type;
  if (f.category && SIGN_CATEGORIES.includes(f.category as SignCategory)) {
    where.category = f.category as SignCategory;
  }
  // Trim + cap the free-text term: bounds the cost of the triple ILIKE scan and
  // keeps the list and export searches identical.
  const q = f.q?.trim().slice(0, 200);
  if (q) {
    where.OR = [
      { signText: { contains: q, mode: "insensitive" } },
      { itemId: { contains: q, mode: "insensitive" } },
      { placementArea: { contains: q, mode: "insensitive" } },
    ];
  }
  // due/overdue. The dashboard is the only thing that sets this and it never
  // also sets a status, so "due implies not-yet-deployed" deliberately takes
  // precedence over any status passed alongside it — set the columns directly
  // (no AND wrapper) so the where stays flat and predictable.
  if (f.due === "today" || f.due === "overdue") {
    const today = pacificTodayUtc();
    where.status = { not: "deployed" };
    where.deployByDate = f.due === "today" ? today : { lt: today };
  }
  return where;
}

// Delivery/deployment stamp changes for a status move. This is a PURE function
// of the target status — it never reads the row's current status to decide what
// to set — which is what lets the bulk path apply one shared patch via
// updateMany across a mixed-status selection:
//   - entering delivered/deployed stamps that step (with who + when)
//   - moving to a status BELOW a step nulls that step's stamps
//   - a step ABOVE the target is simply absent from the patch, so each row keeps
//     its own existing value (e.g. delivered→deployed preserves deliveredAt,
//     while pending→deployed leaves deliveredAt null because it was already null)
export type StampPatch = {
  deliveredAt?: Date | null;
  deliveredBy?: string | null;
  deployedAt?: Date | null;
  deployedBy?: string | null;
  handedOffAt?: Date | null;
  handedOffBy?: string | null;
  installedAt?: Date | null;
  installedBy?: string | null;
};

export function stampsForStatus(
  target: SignStatus,
  changedBy: string,
  now: Date,
): StampPatch {
  const rankOf = (s: SignStatus) => SIGN_STATUSES.indexOf(s);
  const rank = rankOf(target);
  const patch: StampPatch = {};
  if (target === "delivered") {
    patch.deliveredAt = now;
    patch.deliveredBy = changedBy;
  } else if (rank < rankOf("delivered")) {
    patch.deliveredAt = null;
    patch.deliveredBy = null;
  }
  // deployed and the external fork (handed_off/installed) are SIBLING terminals on
  // mutually-exclusive paths — a sign is deployed by us OR installed externally,
  // never both. So clear deployed not just on a rank-below move but whenever we
  // enter the external fork; symmetrically, entering deployed clears handed_off +
  // installed below (they rank above deployed, so the rank rule already nulls them).
  if (target === "deployed") {
    patch.deployedAt = now;
    patch.deployedBy = changedBy;
  } else if (
    rank < rankOf("deployed") ||
    target === "handed_off" ||
    target === "installed"
  ) {
    patch.deployedAt = null;
    patch.deployedBy = null;
  }
  // External-item steps (handed_off / installed). Same rank rule as above: entering
  // the step stamps who+when; moving below it clears its stamp. The structured
  // handoff fields (handedOffTo, photos, notes, receivedQty) are NOT touched here —
  // those are set by the dedicated lifecycle actions; this stays pure so the bulk
  // updateMany path can apply one shared patch across a mixed selection.
  if (target === "handed_off") {
    patch.handedOffAt = now;
    patch.handedOffBy = changedBy;
  } else if (rank < rankOf("handed_off")) {
    patch.handedOffAt = null;
    patch.handedOffBy = null;
  }
  if (target === "installed") {
    patch.installedAt = now;
    patch.installedBy = changedBy;
  } else if (rank < rankOf("installed")) {
    patch.installedAt = null;
    patch.installedBy = null;
  }
  return patch;
}

// LVCC West is the team's home building, so its name is noise in the UI and we
// strip it. Zones in any OTHER building keep their building prefix so an
// off-site location is never mistaken for an LVCC one.
export const HOME_BUILDING = "LVCC West";

// Short, friendly zone label for the UI. For LVCC West zones, render
// "LVCC-L1" -> "Level 1" and "LVCC-H2" -> "Hall 2". For off-site zones, keep
// the building, e.g. "Caesars — Level 1". Falls back to the zone name / code
// for any zone whose code is not an L#/H# level or hall.
export function shortZoneLabel(
  zone:
    | { zoneCode?: string | null; zoneName?: string | null; building?: string | null }
    | null
    | undefined,
): string {
  if (!zone) return "—";
  const { zoneCode, zoneName, building } = zone;
  const m = zoneCode?.match(/-([LH])(\d+)$/i);
  if (m) {
    const descriptor = `${m[1].toUpperCase() === "H" ? "Hall" : "Level"} ${m[2]}`;
    return building && building !== HOME_BUILDING
      ? `${building} — ${descriptor}`
      : descriptor;
  }
  // Non level/hall zone (e.g. a future off-site location): the zone name already
  // carries the building, so show it verbatim.
  return zoneName ?? zoneCode ?? "—";
}

// Rotating-sign deployment slots: con days × AM/PM. Value is stored on the
// Sign as a plain string; label is what the UI shows.
const SLOT_DAYS = ["TUES", "WED", "THU", "FRI", "SAT", "SUN"] as const;
const SLOT_HALVES = ["AM", "PM"] as const;
const DAY_LABELS: Record<(typeof SLOT_DAYS)[number], string> = {
  TUES: "Tue",
  WED: "Wed",
  THU: "Thu",
  FRI: "Fri",
  SAT: "Sat",
  SUN: "Sun",
};

export const DEPLOYMENT_SLOTS: ReadonlyArray<{ value: string; label: string }> =
  SLOT_DAYS.flatMap((day) =>
    SLOT_HALVES.map((half) => ({
      value: `${day}_${half}`,
      label: `${DAY_LABELS[day]} ${half}`,
    })),
  );

const SLOT_LABEL_BY_VALUE = new Map(
  DEPLOYMENT_SLOTS.map((s) => [s.value, s.label]),
);

export function deploymentSlotLabel(value: string | null | undefined): string {
  if (!value) return "—";
  return SLOT_LABEL_BY_VALUE.get(value) ?? value;
}

// signType is a free-text column, but the suggestions surfaced via <datalist> on
// the create/edit form are scoped to the team's real form-factor vocabulary
// (SIGN_FORM_TYPES) — a plain sign is denoted by its size, specials by their
// form. The filter dropdown is built from DISTINCT values actually present in the
// DB, so any legacy/odd type still filters correctly.
export const SIGN_TYPES = SIGN_FORM_TYPES;

// tag.color comes from the DB and is rendered into an inline style. Only allow
// a strict 6-digit hex so a malformed/hostile value can never become a CSS
// injection sink; anything else falls back to zinc-700.
export function safeColor(color: string | null | undefined): string {
  return color && /^#[0-9a-fA-F]{6}$/.test(color) ? color : "#3f3f46";
}

// On-site staff think in Las Vegas (Pacific) time. Format all timestamps to
// that zone with an explicit "PT" suffix so a UTC value is never misread.
const EVENT_TZ = "America/Los_Angeles";

export function formatDateTime(d: Date | null | undefined): string {
  if (!d) return "—";
  const s = new Intl.DateTimeFormat("en-US", {
    timeZone: EVENT_TZ,
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
  return `${s} PT`;
}

export function formatDate(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: EVENT_TZ,
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(d);
}

// "Today" on the Vegas calendar, expressed as a UTC-midnight Date so it lines
// up with how Prisma stores @db.Date (deployByDate) values. Used for the
// dashboard due-today / overdue counts and the matching list filter.
export function pacificTodayUtc(): Date {
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: EVENT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return new Date(`${ymd}T00:00:00.000Z`);
}

// For date-only (@db.Date) values like deployByDate. Prisma returns those as a
// UTC-midnight Date, so format in UTC — using a western tz (formatDate) would
// shift the calendar date back a day.
export function formatDateOnly(d: Date | null | undefined): string {
  if (!d) return "—";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    year: "numeric",
    month: "short",
    day: "2-digit",
  }).format(d);
}

// Human-readable label per workflow stage (Title-case, "Handed off" not the raw
// enum). Drives the filter chips + any status display that wants a friendly label
// instead of the snake_case enum value.
export const STATUS_LABELS: Record<SignStatus, string> = {
  pending: "Pending",
  generated: "Generated",
  printed: "Printed",
  delivered: "Delivered",
  sorted: "Sorted",
  deployed: "Deployed",
  handed_off: "Handed off",
  installed: "Installed",
};

export function statusLabel(status: SignStatus): string {
  return STATUS_LABELS[status] ?? status;
}

// One themed badge class per workflow stage. The colors come from the per-year
// --status-* tokens (see app/theme.css / globals.css `.badge-*`), so badges
// re-theme with the con. Compose with the `.badge` base class (`badge badge-<s>`)
// for the dotted console badge, or pair with `rounded border px-2 py-0.5 text-xs`.
export function statusBadgeClass(status: SignStatus): string {
  switch (status) {
    case "pending":
      return "badge-pending";
    case "generated":
      return "badge-generated";
    case "printed":
      return "badge-printed";
    case "delivered":
      return "badge-delivered";
    case "sorted":
      return "badge-sorted";
    case "deployed":
      return "badge-deployed";
    case "handed_off":
      return "badge-handed_off";
    case "installed":
      return "badge-installed";
    default:
      return "border-zinc-700 bg-zinc-900 text-zinc-300";
  }
}

// Hardware (mounting gear) is broader than easels: easel signs need an easel,
// meterboard signs need a meterboard stand. Derived from needsEasel OR the sign's
// category (meterboard) — category-based so a paper "4x8 (printed)" ops map isn't
// mistaken for a meterboard. hardwareKind names the gear (easel wins if both).
type HardwareInput = { needsEasel: boolean; category: SignCategory };

export function needsHardware(sign: HardwareInput): boolean {
  return sign.needsEasel || sign.category === "meterboard";
}

export function hardwareKind(
  sign: HardwareInput,
): "easel" | "meterboard stand" | null {
  if (sign.needsEasel) return "easel";
  if (sign.category === "meterboard") return "meterboard stand";
  return null;
}

// Build the href for a live-search navigation: carry the other active filters
// (`otherParams`, a query string WITHOUT `q`/`page`), set or clear the trimmed
// search term, and always drop `page` so a new search lands on page 1. Pure so
// the client SearchField island and tests share one source of truth.
export function buildSearchHref(
  pathname: string,
  otherParams: string,
  query: string,
): string {
  const params = new URLSearchParams(otherParams);
  params.delete("page");
  const q = query.trim();
  if (q) params.set("q", q);
  else params.delete("q");
  const qs = params.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}
