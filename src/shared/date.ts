// Date utilities. Storage format: ISO yyyy-mm-dd — the Bangkok CALENDAR day,
// not the server or browser's own local date (see todayBangkok()). Display
// mirrors the paper sheet: Thai Buddhist Era (พ.ศ. = CE + 543). Ported
// unchanged from income-ledger's src/shared/date.ts — see that repo's copy
// for the canonical version; this file must never drift from it EXCEPT for
// isValidIso's impossible-date rejection below (a bug fix made here only —
// income-ledger's copy still accepts impossible dates via regex-only
// validation; port this fix over there too if this ever needs re-syncing).

/** Today's business date as a Bangkok calendar string, regardless of the
 * server/browser's own timezone. This is THE definition of "today" for
 * every entry/month route in the app. */
export function todayBangkok(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function toIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export function parseIso(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
}

export function isoToBuddhist(iso: string): string {
  const d = parseIso(iso);
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear() + 543}`;
}

const THAI_MONTHS = [
  "มกราคม",
  "กุมภาพันธ์",
  "มีนาคม",
  "เมษายน",
  "พฤษภาคม",
  "มิถุนายน",
  "กรกฎาคม",
  "สิงหาคม",
  "กันยายน",
  "ตุลาคม",
  "พฤศจิกายน",
  "ธันวาคม",
];

export function isoToThaiLong(iso: string): string {
  const d = parseIso(iso);
  return `${d.getDate()} ${THAI_MONTHS[d.getMonth()]} ${d.getFullYear() + 543}`;
}

const THAI_MONTHS_SHORT = [
  "ม.ค.",
  "ก.พ.",
  "มี.ค.",
  "เม.ย.",
  "พ.ค.",
  "มิ.ย.",
  "ก.ค.",
  "ส.ค.",
  "ก.ย.",
  "ต.ค.",
  "พ.ย.",
  "ธ.ค.",
];

/** "2026-07" -> "กรกฎาคม 2569", for the month stepper header. */
export function monthToThaiLong(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${THAI_MONTHS[m! - 1]} ${y! + 543}`;
}

/** "2026-07" -> "ก.ค. 2569" */
export function monthToThaiShort(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return `${THAI_MONTHS_SHORT[m! - 1]} ${y! + 543}`;
}

export function shiftDays(iso: string, delta: number): string {
  const d = parseIso(iso);
  d.setDate(d.getDate() + delta);
  return toIso(d);
}

/** Rejects not just the wrong SHAPE but any impossible calendar date — a
 * regex-only check lets a day like 99 or a month like 00 through, and
 * Date.UTC/the Date constructor silently ROLL such values over into a later
 * (or earlier) real date (e.g. 2026-06-99 -> 2026-09-07), which defeats both
 * the no-future-date rule and the current-month lock: a clerk can type an
 * impossible date that lands the entry in a future or already-locked month.
 * Constructing the date via Date.UTC and checking every component round-trips
 * exactly catches this — an out-of-range day/month always changes at least
 * one of year/month/day after normalization. */
export function isValidIso(s: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const roundTripped = new Date(Date.UTC(year, month - 1, day));
  return (
    roundTripped.getUTCFullYear() === year &&
    roundTripped.getUTCMonth() === month - 1 &&
    roundTripped.getUTCDate() === day
  );
}

export function isValidMonth(s: string): boolean {
  return /^\d{4}-\d{2}$/.test(s);
}

/** This month as a Bangkok "YYYY-MM" string. */
export function currentMonthBangkok(): string {
  return todayBangkok().slice(0, 7);
}

export function shiftMonths(month: string, delta: number): string {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y!, m! - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
