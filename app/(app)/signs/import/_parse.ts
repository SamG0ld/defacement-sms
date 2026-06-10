// Low-level parsing helpers for the source-specific importers (signSheet,
// master). Pure + server-safe.
import { DEPLOYMENT_SLOTS } from "../_lib";

const SLOT_VALUES = new Set(DEPLOYMENT_SLOTS.map((s) => s.value));

// Parse a wide "DEPLOY BY <day> <AM/PM> (date)" column header into one of our
// DEPLOYMENT_SLOTS values. Handles the DC33 variants: "DEPLOY BY TUES AM (8/5)",
// "DEPLOY BY WEDS AM (8/6)", "DEPLOY BY THURSD PM (8/7)", "DEPLOY FRI (8/8) 6pm",
// "DEPLOY SAT (8/9) AM", "DEPLOY SUN (8/10) 6pm". Returns null if not a slot.
export function slotFromDeployHeader(text: string): string | null {
  const t = text.toUpperCase();

  let half: "AM" | "PM" | null = null;
  if (/6\s*PM|\bPM\b/.test(t)) half = "PM";
  else if (/\bAM\b/.test(t)) half = "AM";
  if (!half) return null;

  // Day token, most-specific first; all map to our canonical day codes.
  const dayRules: [RegExp, string][] = [
    [/THURSD|THURS|THU/, "THU"],
    [/WEDS|WED/, "WED"],
    [/TUES|TUE/, "TUES"],
    [/FRI/, "FRI"],
    [/SAT/, "SAT"],
    [/SUN/, "SUN"],
  ];
  let day: string | null = null;
  for (const [re, d] of dayRules) {
    if (re.test(t)) {
      day = d;
      break;
    }
  }
  if (!day) return null;

  const slot = `${day}_${half}`;
  return SLOT_VALUES.has(slot) ? slot : null;
}

// Extract the calendar date embedded in a deploy-by column header, e.g.
// "DEPLOY BY WEDS AM (8/6)" -> 2025-08-06. Returns a UTC-midnight Date (the
// column is a date-only @db.Date; format it in UTC to avoid an off-by-one).
export function deployHeaderDate(
  headerText: string,
  year: number,
): Date | null {
  const m = headerText.match(/\((\d{1,2})\/(\d{1,2})\)/);
  if (!m) return null;
  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(Date.UTC(year, month - 1, day));
}

// Map a header row's deploy columns -> { column index, slot }.
export function parseDeployMatrix(
  headerRow: string[],
): { index: number; slot: string }[] {
  const out: { index: number; slot: string }[] = [];
  headerRow.forEach((h, i) => {
    if (/deploy/i.test(h)) {
      const slot = slotFromDeployHeader(h);
      if (slot) out.push({ index: i, slot });
    }
  });
  return out;
}

// DC is always early August (PDT = UTC-7). Construct the Date so the stored
// instant renders back as the intended Las Vegas wall-clock time.
const DC_UTC_OFFSET_HOURS = 7;
function vegasDate(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  return new Date(Date.UTC(year, month - 1, day, hour + DC_UTC_OFFSET_HOURS, minute));
}

// Parse a rotating-sign time window out of a Notes cell, e.g.
// "Friday (8/8) 19:00:00 - Friday (8/8) 21:00:00" or "Friday (8/8) 16:00 - 18:00".
// Uses the first window only (before any ';'). year is the con year (e.g. 2025).
export function parseEventWindow(
  notes: string | null,
  year: number,
): { eventStart: Date | null; eventEnd: Date | null } {
  if (!notes) return { eventStart: null, eventEnd: null };
  const seg = notes.split(";")[0];

  const dates = [...seg.matchAll(/\((\d{1,2})\/(\d{1,2})\)/g)].map((m) => ({
    mo: Number(m[1]),
    d: Number(m[2]),
  }));
  const times = [...seg.matchAll(/(\d{1,2}):(\d{2})/g)].map((m) => ({
    h: Number(m[1]),
    mi: Number(m[2]),
  }));
  if (dates.length === 0 || times.length === 0) {
    return { eventStart: null, eventEnd: null };
  }

  const startDate = dates[0];
  const endDate = dates[1] ?? startDate;
  const startTime = times[0];
  const endTime = times[1] ?? times[0];

  const inRange = (mo: number, d: number, h: number, mi: number): boolean =>
    mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && h <= 23 && mi <= 59;

  return {
    eventStart: inRange(startDate.mo, startDate.d, startTime.h, startTime.mi)
      ? vegasDate(year, startDate.mo, startDate.d, startTime.h, startTime.mi)
      : null,
    eventEnd: inRange(endDate.mo, endDate.d, endTime.h, endTime.mi)
      ? vegasDate(year, endDate.mo, endDate.d, endTime.h, endTime.mi)
      : null,
  };
}

// Find the index of the header row (the first row containing every required
// header label as an exact cell, case-insensitive). -1 if not found.
export function findHeaderRow(rows: string[][], required: string[]): number {
  const want = required.map((r) => r.toLowerCase());
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].map((c) => c.trim().toLowerCase());
    if (want.every((w) => cells.includes(w))) return i;
  }
  return -1;
}

// Detect an LVCC North Hall reference -> the single North zone code, or null.
// North Hall is the separate LVCC building across the tram from West: the
// "Diamond" ballrooms and the N2xx workshop/training rooms (e.g. "LVCC North
// Hall, DIAMOND", "L2 - N260", room "N253", "Diamond 3 & 4"). MUST be checked
// before levelToZoneCode, since these rows also carry a Level that would
// otherwise mis-file them into a West level zone. Matchers are scoped tight to
// avoid winning precedence on a stray token: "diamond" as a whole word, and the
// room code bounded to the actual N2xx range (N252-N265 in the DC33 sheets).
export function northHallZoneCode(text: string): string | null {
  const t = text.toLowerCase();
  if (/north hall|\bdiamond\b/.test(t) || /\bn2\d{2}\b/.test(t)) return "LVCC-NH";
  return null;
}

// Detect a Hall reference -> hall zone code (LVCC-H1..H4), or null. Matches the
// DC33 section labels ("Hall 1") and location strings ("L1 - HW4 - C107"). Does
// NOT match bare "W104"-style room codes (requires "hall" or "hw").
export function hallZoneCode(text: string): string | null {
  const m = text.toLowerCase().match(/\bhall\s*([1-4])\b|\bhw\s*-?\s*([1-4])\b/);
  if (!m) return null;
  return `LVCC-H${m[1] ?? m[2]}`;
}

// Map a floor/level/location string -> a seeded zone code (LVCC-L1/2/3), or null.
export function levelToZoneCode(text: string): string | null {
  const t = text.trim().toLowerCase();
  let lvl: string | null = null;
  const m = t.match(/level\s*([123])|^l\s*-?\s*([123])\b|\bl([123])\b/);
  if (m) lvl = m[1] || m[2] || m[3];
  else if (/first floor/.test(t)) lvl = "1";
  else if (/second floor/.test(t)) lvl = "2";
  else if (/third floor/.test(t)) lvl = "3";
  return lvl ? `LVCC-L${lvl}` : null;
}
