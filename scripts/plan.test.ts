import { describe, expect, test } from "bun:test";

import { bangkokNoonUnixSeconds } from "./lib/dates.ts";
import { IMPORT_COMMENT_PREFIX, buildPlannedTransactions, categoryKey, summarizePlan } from "./lib/plan.ts";
import type { DailyRow } from "./lib/workbook.ts";

describe("buildPlannedTransactions", () => {
  test("one transaction per non-empty cell, plain comment when the day has no note", () => {
    const rows: DailyRow[] = [
      {
        rowNumber: 5,
        date: { year: 2026, month: 7, day: 1 },
        note: "",
        cells: [
          { column: "E", code: "breakfast", categoryLabel: "ค่าอาหารเช้า", secondaryLabel: "ค่าอาหารเช้า", amountMajor: 100 },
          { column: "I", code: "water-utility", categoryLabel: "ค่าน้ำประปา", secondaryLabel: "สายชล", amountMajor: 50.5 },
        ],
      },
    ];

    const planned = buildPlannedTransactions(rows);

    expect(planned).toHaveLength(2);
    expect(planned[0]!.comment).toBe(IMPORT_COMMENT_PREFIX);
    expect(planned[1]!.comment).toBe(IMPORT_COMMENT_PREFIX);
    expect(planned[0]!.amountMinorUnits).toBe(10000);
    expect(planned[1]!.amountMinorUnits).toBe(5050);
    expect(planned[0]!.unixTime).toBe(bangkokNoonUnixSeconds(rows[0]!.date));
    expect(planned[0]!.utcOffsetMinutes).toBe(420);
  });

  test("attaches the day's note only to the first transaction of that day", () => {
    const rows: DailyRow[] = [
      {
        rowNumber: 6,
        date: { year: 2026, month: 7, day: 2 },
        note: "ปิดปรับปรุง",
        cells: [
          { column: "F", code: "housekeeping", categoryLabel: "ค่าใช้จ่าย-แม่บ้าน", secondaryLabel: "ค่าใช้จ่าย-แม่บ้าน", amountMajor: 200 },
          { column: "J", code: "water-utility", categoryLabel: "ค่าน้ำประปา", secondaryLabel: "Hop inn 47", amountMajor: 75 },
        ],
      },
    ];

    const planned = buildPlannedTransactions(rows);

    expect(planned[0]!.comment).toBe(`${IMPORT_COMMENT_PREFIX} - ปิดปรับปรุง`);
    expect(planned[1]!.comment).toBe(IMPORT_COMMENT_PREFIX); // not repeated
  });

  test("a note on a day with zero expense cells attaches to nothing (no transaction created)", () => {
    const rows: DailyRow[] = [{ rowNumber: 7, date: { year: 2026, month: 7, day: 3 }, note: "note-with-no-cells", cells: [] }];
    expect(buildPlannedTransactions(rows)).toEqual([]);
  });

  test("note placement resets per day", () => {
    const rows: DailyRow[] = [
      {
        rowNumber: 5,
        date: { year: 2026, month: 7, day: 1 },
        note: "day1 note",
        cells: [{ column: "E", code: "breakfast", categoryLabel: "ค่าอาหารเช้า", secondaryLabel: "ค่าอาหารเช้า", amountMajor: 10 }],
      },
      {
        rowNumber: 6,
        date: { year: 2026, month: 7, day: 2 },
        note: "day2 note",
        cells: [{ column: "E", code: "breakfast", categoryLabel: "ค่าอาหารเช้า", secondaryLabel: "ค่าอาหารเช้า", amountMajor: 20 }],
      },
    ];

    const planned = buildPlannedTransactions(rows);
    expect(planned[0]!.comment).toBe(`${IMPORT_COMMENT_PREFIX} - day1 note`);
    expect(planned[1]!.comment).toBe(`${IMPORT_COMMENT_PREFIX} - day2 note`);
  });
});

describe("categoryKey", () => {
  test("joins code and secondary label with a stable separator", () => {
    expect(categoryKey("water-utility", "สายชล")).toBe("water-utility::สายชล");
  });
});

describe("summarizePlan", () => {
  test("groups planned transactions by category key, summing amounts and counting", () => {
    const rows: DailyRow[] = [
      {
        rowNumber: 5,
        date: { year: 2026, month: 7, day: 1 },
        note: "",
        cells: [
          { column: "E", code: "breakfast", categoryLabel: "ค่าอาหารเช้า", secondaryLabel: "ค่าอาหารเช้า", amountMajor: 100 },
          { column: "I", code: "water-utility", categoryLabel: "ค่าน้ำประปา", secondaryLabel: "สายชล", amountMajor: 50 },
        ],
      },
      {
        rowNumber: 6,
        date: { year: 2026, month: 7, day: 2 },
        note: "",
        cells: [{ column: "E", code: "breakfast", categoryLabel: "ค่าอาหารเช้า", secondaryLabel: "ค่าอาหารเช้า", amountMajor: 60 }],
      },
    ];

    const planned = buildPlannedTransactions(rows);
    const labels = new Map([
      [categoryKey("breakfast", "ค่าอาหารเช้า"), "ค่าอาหารเช้า > ค่าอาหารเช้า"],
      [categoryKey("water-utility", "สายชล"), "ค่าน้ำประปา > สายชล"],
    ]);

    const summary = summarizePlan(planned, labels);
    expect(summary).toHaveLength(2);

    const breakfast = summary.find((s) => s.categoryKey === categoryKey("breakfast", "ค่าอาหารเช้า"));
    expect(breakfast).toMatchObject({ count: 2, amountMinorUnits: 16000 });

    const water = summary.find((s) => s.categoryKey === categoryKey("water-utility", "สายชล"));
    expect(water).toMatchObject({ count: 1, amountMinorUnits: 5000 });
  });
});
