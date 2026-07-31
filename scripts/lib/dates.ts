// Date handling for the workbook import - deliberately pure, no SheetJS
// dependency, so it can be unit tested in isolation.
//
// The workbook's date column stores plain Excel serial numbers, but the
// underlying serial was produced by a Thai-locale Excel that read a typed
// Buddhist-era date (e.g. "1/7/69" meaning 1 กรกฎาคม 2569) and serialized it
// using ordinary Gregorian date-serial arithmetic with 2569 taken literally
// as the calendar year - i.e. the same serial number Excel would produce for
// the (nonsensical, but arithmetically valid) Gregorian date 1 July 2569.
// Verified against the real July workbook: serial 244531 decodes (via plain
// epoch-day arithmetic, matching XLSX.SSF.parse_date_code) to
// {year: 2569, month: 7, day: 1} - not 2026. So converting to CE only needs
// a flat -543 year offset once the serial has been decoded; no further
// calendar reinterpretation is needed.
//
// Deliberately NOT using SheetJS's cellDates:true / JS Date conversion path:
// that round-trips through floating point and lands a few seconds before
// midnight on whole-day serials (e.g. 2569-06-30T16:59:56Z for what should
// be exactly 2569-07-01T00:00:00Z), which would corrupt the day component
// depending on which date part is read back out.

export const BUDDHIST_TO_CE_YEAR_OFFSET = 543;

/** Bangkok has no DST; this offset is constant year-round. */
export const BANGKOK_UTC_OFFSET_MINUTES = 420;

export interface CalendarDate {
  year: number;
  month: number; // 1-12
  day: number;
}

const EXCEL_EPOCH_UTC_MS = Date.UTC(1899, 11, 30);
const MS_PER_DAY = 86_400_000;

/**
 * Decodes a whole-day Excel serial number into {year, month, day} using
 * plain integer epoch-day arithmetic (serial 0 = 1899-12-30). Does NOT
 * apply the Buddhist -> CE correction - see excelSerialToCeDate() for that.
 */
export function excelSerialToCalendarDate(serial: number): CalendarDate {
  const days = Math.round(serial);
  const ms = EXCEL_EPOCH_UTC_MS + days * MS_PER_DAY;
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Excel serial -> CE calendar date, applying the -543 Buddhist year offset. */
export function excelSerialToCeDate(serial: number): CalendarDate {
  const raw = excelSerialToCalendarDate(serial);
  return { year: raw.year - BUDDHIST_TO_CE_YEAR_OFFSET, month: raw.month, day: raw.day };
}

/** Unix seconds for 12:00 Asia/Bangkok (UTC+7) on the given CE calendar date. */
export function bangkokNoonUnixSeconds(date: CalendarDate): number {
  const utcNoonMs = Date.UTC(date.year, date.month - 1, date.day, 12, 0, 0);
  const ms = utcNoonMs - BANGKOK_UTC_OFFSET_MINUTES * 60_000;
  return Math.floor(ms / 1000);
}

/** "2026-07" style year-month key, used for the import tag name. */
export function ymKey(date: { year: number; month: number }): string {
  return `${date.year}-${String(date.month).padStart(2, "0")}`;
}
