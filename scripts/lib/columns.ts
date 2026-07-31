// Fixed workbook <-> category mapping for the monthly "รายงานรายได้-รายจ่าย"
// daily sheet. Verified against the July 2569 (2026) workbook: columns E..Y
// map to expense categories exactly, in this order, with columns B-D
// (revenue) deliberately skipped - income-ledger owns revenue - and column Z
// carrying a day-level หมายเหตุ (note). See HF-erp's
// docs/expense-ledger-plan.md and the task spec for the source mapping.
//
// `secondaryIndex` indexes into that code's `secondaries` array in
// categories.json (see lib/categories-config.ts) - this is how a column
// that shares a primary category with other columns (water-utility,
// electricity, phone each span 2-3 columns) resolves to a distinct
// secondary category per column.

export interface ExpenseColumnEntry {
  /** Spreadsheet column letter, A=0-indexed via columnLetterToIndex(). */
  column: string;
  /** Matches a categories.json primary "code". */
  code: string;
  /** Index into that primary's "secondaries" array. */
  secondaryIndex: number;
}

export const DATE_COLUMN = "A";
export const NOTE_COLUMN = "Z";
export const TOTALS_ROW_LABEL = "รวม";

/** 1-indexed spreadsheet row where daily data begins (rows 1-4 are headers). */
export const DATA_START_ROW = 5;

export const EXPENSE_COLUMNS: readonly ExpenseColumnEntry[] = [
  { column: "E", code: "breakfast", secondaryIndex: 0 },
  { column: "F", code: "housekeeping", secondaryIndex: 0 },
  { column: "G", code: "water-bar", secondaryIndex: 0 },
  { column: "H", code: "repair-appliance", secondaryIndex: 0 },
  { column: "I", code: "water-utility", secondaryIndex: 0 }, // สายชล
  { column: "J", code: "water-utility", secondaryIndex: 1 }, // Hop inn 47
  { column: "K", code: "water-utility", secondaryIndex: 2 }, // HF Ville
  { column: "L", code: "electricity", secondaryIndex: 0 }, // สายชล
  { column: "M", code: "electricity", secondaryIndex: 1 }, // HF Ville
  { column: "N", code: "electricity", secondaryIndex: 2 }, // Hop inn 47
  { column: "O", code: "phone", secondaryIndex: 0 }, // สายชล+ออฟฟิต
  { column: "P", code: "phone", secondaryIndex: 1 }, // HF Ville
  { column: "Q", code: "salary", secondaryIndex: 0 },
  { column: "R", code: "commission-staff", secondaryIndex: 0 },
  { column: "S", code: "commission-booking", secondaryIndex: 0 },
  { column: "T", code: "commission-expedia", secondaryIndex: 0 },
  { column: "U", code: "laundry", secondaryIndex: 0 },
  { column: "V", code: "repair-building", secondaryIndex: 0 },
  { column: "W", code: "supplies", secondaryIndex: 0 },
  { column: "X", code: "social-security", secondaryIndex: 0 },
  { column: "Y", code: "other", secondaryIndex: 0 },
];

/** Column letter (e.g. "E") -> 0-based array index (4). Single letters only - this workbook never needs AA+. */
export function columnLetterToIndex(column: string): number {
  return column.charCodeAt(0) - "A".charCodeAt(0);
}
