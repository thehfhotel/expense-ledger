import { describe, expect, test } from "bun:test";

import { bangkokNoonUnixSeconds, excelSerialToCalendarDate, excelSerialToCeDate, ymKey } from "./lib/dates.ts";

describe("excelSerialToCalendarDate", () => {
  test("decodes the raw serial without any Buddhist correction", () => {
    // Verified against XLSX.SSF.parse_date_code(244531) on the real July
    // workbook: this serial's raw epoch-day arithmetic lands on year 2569,
    // not 2026 - the Buddhist year is embedded directly in the serial.
    expect(excelSerialToCalendarDate(244531)).toEqual({ year: 2569, month: 7, day: 1 });
  });

  test("rounds fractional serials to the nearest whole day", () => {
    expect(excelSerialToCalendarDate(244531.0001)).toEqual({ year: 2569, month: 7, day: 1 });
  });
});

describe("excelSerialToCeDate", () => {
  test("applies the -543 Buddhist year offset, keeping month/day untouched", () => {
    expect(excelSerialToCeDate(244531)).toEqual({ year: 2026, month: 7, day: 1 });
  });

  test("matches consecutive workbook dates across the month", () => {
    // Serials taken directly from the real July workbook's column A (verified
    // during development, not read from the file here).
    expect(excelSerialToCeDate(244532)).toEqual({ year: 2026, month: 7, day: 2 });
    expect(excelSerialToCeDate(244546)).toEqual({ year: 2026, month: 7, day: 16 });
  });

  test("handles a month boundary", () => {
    // 2569-06-30 -> one day before serial 244531 (2569-07-01).
    expect(excelSerialToCeDate(244530)).toEqual({ year: 2026, month: 6, day: 30 });
  });
});

describe("bangkokNoonUnixSeconds", () => {
  test("returns the unix instant for 12:00 Asia/Bangkok (UTC+7)", () => {
    const unix = bangkokNoonUnixSeconds({ year: 2026, month: 7, day: 1 });
    expect(new Date(unix * 1000).toISOString()).toBe("2026-07-01T05:00:00.000Z");
  });

  test("is stable across the day the same way regardless of month", () => {
    const unix = bangkokNoonUnixSeconds({ year: 2026, month: 1, day: 31 });
    expect(new Date(unix * 1000).toISOString()).toBe("2026-01-31T05:00:00.000Z");
  });
});

describe("ymKey", () => {
  test("pads single-digit months", () => {
    expect(ymKey({ year: 2026, month: 7 })).toBe("2026-07");
    expect(ymKey({ year: 2026, month: 1 })).toBe("2026-01");
  });

  test("does not pad double-digit months", () => {
    expect(ymKey({ year: 2026, month: 12 })).toBe("2026-12");
  });
});
