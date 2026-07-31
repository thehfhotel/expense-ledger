import * as XLSX from "xlsx";

import type { CategoriesConfig } from "./categories-config.ts";
import { DATA_START_ROW, DATE_COLUMN, EXPENSE_COLUMNS, NOTE_COLUMN, TOTALS_ROW_LABEL, columnLetterToIndex } from "./columns.ts";
import { type CalendarDate, excelSerialToCeDate } from "./dates.ts";
import { resolveColumnCategory } from "./mapping.ts";

export interface DailyExpenseCell {
  column: string;
  code: string;
  categoryLabel: string;
  secondaryLabel: string;
  amountMajor: number;
}

export interface DailyRow {
  /** 1-indexed spreadsheet row number, for error messages. */
  rowNumber: number;
  date: CalendarDate; // CE
  note: string;
  /** Only non-empty, non-zero expense cells, in column order. */
  cells: DailyExpenseCell[];
}

export interface DailySheetParseResult {
  rows: DailyRow[];
  /** Column letter -> the workbook's own "รวม" row total (major units, baht). */
  totals: Record<string, number>;
}

export interface ItemizedRow {
  rowNumber: number;
  date: CalendarDate; // CE
  description: string;
  amountMajor: number;
  note: string;
}

function cellRaw(row: unknown[], column: string): unknown {
  return row[columnLetterToIndex(column)];
}

function cellText(row: unknown[], column: string): string {
  const v = cellRaw(row, column);
  return v === undefined || v === null ? "" : String(v).trim();
}

function cellNumber(row: unknown[], column: string): number {
  const v = cellRaw(row, column);
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function sheetToRows(sheet: XLSX.WorkSheet): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });
}

/**
 * Parses the daily "รายงานรายได้-รายจ่าย" sheet: header rows 1-4, daily data
 * from row 5 until the row whose column A reads "รวม" (the totals row).
 * Columns B-D (revenue) are intentionally never read - income-ledger owns
 * revenue. Throws if no totals row is found (a workbook shape we don't
 * recognise - safer to fail than to silently import a partial month).
 */
export function parseDailySheet(sheet: XLSX.WorkSheet, categories: CategoriesConfig): DailySheetParseResult {
  const rows = sheetToRows(sheet);

  const dailyRows: DailyRow[] = [];
  const totals: Record<string, number> = {};
  let totalsRowFound = false;

  for (let i = DATA_START_ROW - 1; i < rows.length; i++) {
    const row = rows[i]!;
    const label = cellText(row, DATE_COLUMN);

    if (label === TOTALS_ROW_LABEL) {
      for (const { column } of EXPENSE_COLUMNS) {
        totals[column] = cellNumber(row, column);
      }
      totalsRowFound = true;
      break;
    }

    const serial = cellRaw(row, DATE_COLUMN);
    if (typeof serial !== "number") continue; // blank/stray row before the totals row

    const date = excelSerialToCeDate(serial);
    const note = cellText(row, NOTE_COLUMN);

    const cells: DailyExpenseCell[] = [];

    for (const entry of EXPENSE_COLUMNS) {
      const amountMajor = cellNumber(row, entry.column);
      if (!amountMajor) continue; // skip empty AND zero cells

      const resolved = resolveColumnCategory(entry.column, categories);
      if (!resolved) {
        throw new Error(
          `column ${entry.column} (row ${i + 1}) maps to category code "${entry.code}" (secondary index ${entry.secondaryIndex}), which is missing from categories.json`,
        );
      }

      cells.push({
        column: entry.column,
        code: resolved.code,
        categoryLabel: resolved.label,
        secondaryLabel: resolved.secondaryLabel,
        amountMajor,
      });
    }

    dailyRows.push({ rowNumber: i + 1, date, note, cells });
  }

  if (!totalsRowFound) {
    throw new Error(`could not find the totals row ("${TOTALS_ROW_LABEL}") in the daily sheet`);
  }

  return { rows: dailyRows, totals };
}

/** 1-indexed row where itemized data begins (rows 1-2 are headers: title, then column headers). */
const ITEMIZED_DATA_START_ROW = 3;

/**
 * Parses the itemized "ค่าใช้จ่าย" sheet (วัน เดือน ปี | รายการ | จำนวนเงิน |
 * หมายเหตุ). Returns [] both when the sheet is absent and when it has no
 * data rows (this workbook's July sheet is empty) - callers decide what,
 * if anything, to do with a non-empty result; this function only parses.
 */
export function parseItemizedSheet(sheet: XLSX.WorkSheet | undefined): ItemizedRow[] {
  if (!sheet) return [];

  const rows = sheetToRows(sheet);
  const result: ItemizedRow[] = [];

  for (let i = ITEMIZED_DATA_START_ROW - 1; i < rows.length; i++) {
    const row = rows[i]!;
    const serial = cellRaw(row, "A");
    const amountMajor = cellNumber(row, "C");

    if (typeof serial !== "number" || !amountMajor) continue; // blank row, not itemized data

    result.push({
      rowNumber: i + 1,
      date: excelSerialToCeDate(serial),
      description: cellText(row, "B"),
      amountMajor,
      note: cellText(row, "D"),
    });
  }

  return result;
}
