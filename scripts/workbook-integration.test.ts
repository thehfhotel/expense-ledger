// Skippable integration test: parses the REAL July 2569/2026 workbook if
// it happens to exist on this machine (it never will in CI or on another
// contributor's machine - the file is local-only and is never committed,
// per CLAUDE.md's public-repo hygiene rule). No network calls here, parsing
// only - just a spot-check that lib/workbook.ts's totals-row extraction
// matches the workbook's own รวม row for a handful of known columns.
import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";

import categoriesData from "./categories.json";
import type { CategoriesConfig } from "./lib/categories-config.ts";
import { findDailySheetName } from "./lib/mapping.ts";
import { parseDailySheet } from "./lib/workbook.ts";

const REAL_WORKBOOK_PATH = "/Users/nut/Downloads/รายงานรายได้-รายจ่าย   กรกฎาคม  2569.xlsx";
const fileExists = existsSync(REAL_WORKBOOK_PATH);

describe("real July workbook (local-only, skipped when absent)", () => {
  test.skipIf(!fileExists)("รวม row totals match the known spot-check values", () => {
    const categories = categoriesData as CategoriesConfig;
    const workbook = XLSX.readFile(REAL_WORKBOOK_PATH, { cellDates: false });
    const sheetName = findDailySheetName(workbook.SheetNames);
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) throw new Error(`sheet "${sheetName}" not found`);

    const result = parseDailySheet(sheet, categories);

    // From the task's July spot-checks.
    expect(result.totals.V).toBeCloseTo(55_681.6, 2); // repair-building
    expect(result.totals.W).toBeCloseTo(52_860.5, 2); // supplies
    expect(result.totals.Y).toBeCloseTo(152_319.0, 2); // other
    expect(result.totals.E).toBeCloseTo(20_760.75, 2); // breakfast
    expect(result.totals.F).toBeCloseTo(29_804.5, 2); // housekeeping

    expect(result.rows.length).toBeGreaterThan(0);
    expect(result.rows[0]!.date.year).toBe(2026);
    expect(result.rows[0]!.date.month).toBe(7);
  });

  if (!fileExists) {
    test("skipped - real workbook not present on this machine", () => {
      expect(fileExists).toBe(false);
    });
  }
});
