import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";

import type { CategoriesConfig } from "./lib/categories-config.ts";
import { parseDailySheet, parseItemizedSheet } from "./lib/workbook.ts";

// Synthetic fixture only - never the real workbook file (see scripts/workbook-integration.test.ts
// for the skippable real-file check).

const categories: CategoriesConfig = {
  primaries: [
    { code: "breakfast", label: "ค่าอาหารเช้า", icon: "1", color: "ff9500", secondaries: ["ค่าอาหารเช้า"] },
    { code: "housekeeping", label: "ค่าใช้จ่าย-แม่บ้าน", icon: "260", color: "5ac8fa", secondaries: ["ค่าใช้จ่าย-แม่บ้าน"] },
    { code: "water-utility", label: "ค่าน้ำประปา", icon: "270", color: "2196f3", secondaries: ["สายชล", "Hop inn 47", "HF Ville"] },
  ],
  accounts: [],
};

function blankRow(): (number | string)[] {
  return new Array(26).fill("");
}

function buildDailySheet(): XLSX.WorkSheet {
  const rows: (number | string)[][] = [];
  rows[0] = blankRow();
  rows[0]![0] = "รายงานรายรับ-รายจ่าย ตัวอย่าง";
  rows[1] = blankRow();
  rows[2] = blankRow();
  rows[3] = blankRow();

  // row 5 (index 4): serial 244531 = พ.ศ. 2569-07-01 = CE 2026-07-01, no note
  const row5 = blankRow();
  row5[0] = 244531; // A: date
  row5[4] = 100; // E: breakfast
  row5[8] = 50; // I: water-utility / สายชล
  rows[4] = row5;

  // row 6 (index 5): CE 2026-07-02 - has a day note; E is zero (must be skipped),
  // so F is the day's first non-empty cell and should carry the note.
  const row6 = blankRow();
  row6[0] = 244532;
  row6[4] = 0; // E: zero - skip
  row6[5] = 200; // F: housekeeping - first non-empty cell of the day
  row6[9] = 75; // J: water-utility / Hop inn 47 - second non-empty cell of the day
  row6[25] = "note-day2"; // Z
  rows[5] = row6;

  // row 7 (index 6): CE 2026-07-03 - a note but zero expense cells, nothing to attach it to
  const row7 = blankRow();
  row7[0] = 244533;
  row7[25] = "note-day3-no-cells";
  rows[6] = row7;

  // totals row
  const totalsRow = blankRow();
  totalsRow[0] = "รวม";
  totalsRow[4] = 100; // E
  totalsRow[5] = 200; // F
  totalsRow[8] = 50; // I
  totalsRow[9] = 75; // J
  rows[7] = totalsRow;

  return XLSX.utils.aoa_to_sheet(rows);
}

describe("parseDailySheet", () => {
  test("parses data rows, skips empty/zero cells, and stops at the totals row", () => {
    const result = parseDailySheet(buildDailySheet(), categories);

    expect(result.rows).toHaveLength(3);

    const [day1, day2, day3] = result.rows;
    expect(day1!.date).toEqual({ year: 2026, month: 7, day: 1 });
    expect(day1!.cells.map((c) => c.column)).toEqual(["E", "I"]);
    expect(day1!.cells[0]).toMatchObject({ code: "breakfast", secondaryLabel: "ค่าอาหารเช้า", amountMajor: 100 });
    expect(day1!.cells[1]).toMatchObject({ code: "water-utility", secondaryLabel: "สายชล", amountMajor: 50 });

    expect(day2!.date).toEqual({ year: 2026, month: 7, day: 2 });
    expect(day2!.note).toBe("note-day2");
    expect(day2!.cells.map((c) => c.column)).toEqual(["F", "J"]); // E was zero -> skipped

    expect(day3!.date).toEqual({ year: 2026, month: 7, day: 3 });
    expect(day3!.note).toBe("note-day3-no-cells");
    expect(day3!.cells).toEqual([]);
  });

  test("captures the workbook's own รวม totals per column", () => {
    const result = parseDailySheet(buildDailySheet(), categories);
    expect(result.totals.E).toBe(100);
    expect(result.totals.F).toBe(200);
    expect(result.totals.I).toBe(50);
    expect(result.totals.J).toBe(75);
    expect(result.totals.K).toBe(0);
  });

  test("throws when categories.json is missing a category a column expects", () => {
    const incomplete: CategoriesConfig = { primaries: [], accounts: [] };
    expect(() => parseDailySheet(buildDailySheet(), incomplete)).toThrow();
  });

  test("throws when there is no totals row", () => {
    const rows: (number | string)[][] = [blankRow(), blankRow(), blankRow(), blankRow()];
    const row5 = blankRow();
    row5[0] = 244531;
    rows.push(row5);
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    expect(() => parseDailySheet(sheet, categories)).toThrow();
  });
});

describe("parseItemizedSheet", () => {
  test("returns [] for an undefined sheet", () => {
    expect(parseItemizedSheet(undefined)).toEqual([]);
  });

  test("returns [] for a sheet with headers but no data rows (this month's real shape)", () => {
    const rows: (number | string)[][] = [blankRow(), blankRow(), blankRow()];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    expect(parseItemizedSheet(sheet)).toEqual([]);
  });

  test("parses itemized rows when present", () => {
    const rows: (number | string)[][] = [blankRow(), blankRow()];
    const row3 = blankRow();
    row3[0] = 244531; // A: date
    row3[1] = "ค่าอะไหล่"; // B: description
    row3[2] = 999.5; // C: amount
    row3[3] = "หมายเหตุทดสอบ"; // D: note
    rows.push(row3);
    const sheet = XLSX.utils.aoa_to_sheet(rows);

    const result = parseItemizedSheet(sheet);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      date: { year: 2026, month: 7, day: 1 },
      description: "ค่าอะไหล่",
      amountMajor: 999.5,
      note: "หมายเหตุทดสอบ",
    });
  });
});
