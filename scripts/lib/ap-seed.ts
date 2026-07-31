// Pure row-selection/mapping rules for seeding the AP register ("ค้างจ่าย"
// tab, src/server/apStore.ts) from the office's per-creditor workbook
// family (one sheet per month, e.g. "ก.ค.-69.คุณนัท " — note the trailing
// space, the workbook's own naming). Deliberately free of any xlsx /
// bun:sqlite / server dependency, so every rule here is unit-testable
// against plain arrays of cell values (see ap-seed.test.ts) and reusable
// unchanged by both run contexts scripts/seed-ap-2026-07.ts needs — the
// local (laptop) dry-run over the real workbook, and the in-container
// --apply path that only ever sees pre-parsed JSON.
//
// Column layout (0-indexed array position, sheet_to_json({header: 1})),
// fixed for this workbook family — header row 2, data rows 4+:
//   A(0) ชื่อเจ้าหนี้        creditor
//   B(1) รายการ             item
//   C(2) จำนวนเงิน          amount (base, pre-VAT/WHT)
//   D(3) VAT 7%             vat
//   E(4) ภาษีหัก ณ ที่จ่าย   withholding tax
//   F(5) จำนวนรวม           gross total (workbook's own, informational only —
//                            never read; the app recomputes gross itself)
//   G(6) มัดจำ              deposit already recorded on paper
//   H(7)/I(8)/J(9) งวดที่ 1-3   installments already recorded on paper
//   K(10) ส่วนลด            discount
//   L(11) ยอดค้างชำระ        outstanding — the SELECTION rule's amount test
//   M(12) กำหนดชำระ          due date (Excel serial, Buddhist-era year)
//   N(13) จำนวนรวมจ่าย       total paid so far (workbook's own tracking column,
//                            informational only — see checkRowIntegrity's doc
//                            comment for why it is NOT part of the selection
//                            or integrity rule)
//   O(14) ในนาม             entity, carried verbatim
//   P(15) (free-text)       paid/status note — the SELECTION rule's text test
//
// SELECTION RULE (owner-specified, 2026-07): a row is an open, unpaid AP
// item worth seeding iff L > 0 AND P does NOT contain the literal marker
// "จ่ายแล้ว" ("paid already"). Mechanical and creditor-agnostic — never
// special-cased per row.

import type { ExpenseCategoryCode } from "../../src/shared/categories.ts";
import type { ApRowInput } from "../../src/shared/apTypes.ts";
import { amountToMinorUnits } from "./currency.ts";
import { excelSerialToCeDate } from "./dates.ts";

export const COL_CREDITOR = 0;
export const COL_ITEM = 1;
export const COL_AMOUNT = 2;
export const COL_VAT = 3;
export const COL_WHT = 4;
export const COL_DEPOSIT = 6;
export const COL_INSTALLMENT_1 = 7;
export const COL_INSTALLMENT_2 = 8;
export const COL_INSTALLMENT_3 = 9;
export const COL_DISCOUNT = 10;
export const COL_OUTSTANDING = 11;
export const COL_DUE = 12;
export const COL_ENTITY = 14;
export const COL_STATUS = 15;

export const PAID_MARKER = "จ่ายแล้ว";

// ── cell helpers ────────────────────────────────────────────────────────

export function cellRaw(row: readonly unknown[], index: number): unknown {
  return row[index];
}

export function cellText(row: readonly unknown[], index: number): string {
  const v = row[index];
  return v === undefined || v === null ? "" : String(v).trim();
}

function isBlankCell(v: unknown): boolean {
  return v === undefined || v === null || v === "";
}

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export function cellNumber(row: readonly unknown[], index: number): number {
  return toNumber(row[index]);
}

// ── selection rule ──────────────────────────────────────────────────────

export function isOpenUnpaidRow(outstandingBaht: number, statusText: string): boolean {
  return outstandingBaht > 0 && !statusText.includes(PAID_MARKER);
}

// ── category mapping (owner-specified, 2026-07) ────────────────────────

export type SeedCategoryCode = Extract<ExpenseCategoryCode, "commission-booking" | "commission-expedia" | "housekeeping">;

/** Only the three creditor families the owner explicitly mapped. Anything
 * else returns null and the caller must SKIP the row (never guess/default
 * to "other") — see evaluateWorkbookRow. */
export function resolveSeedCategory(creditor: string, item: string): SeedCategoryCode | null {
  if (creditor.includes("Booking.com")) return "commission-booking";
  if (creditor.toLowerCase().includes("expedia")) return "commission-expedia";
  if (creditor.includes("บุญดี") || item.includes("ของใช้แม่บ้าน")) return "housekeeping";
  return null;
}

// ── integrity check (generalizes the "malformed/partial-payment" cases) ─

export interface RowIntegrityInput {
  amountBaht: number;
  vatBaht: number;
  whtBaht: number;
  discountBaht: number;
  outstandingBaht: number; // workbook column L
  depositBaht: number;
  installment1Baht: number;
  installment2Baht: number;
  installment3Baht: number;
}

export interface RowIntegrityResult {
  ok: boolean;
  reason?: string;
}

/** A row passes iff (a) the workbook records NO deposit/installment amount
 * (G/H/I/J) — if it does, a real partial payment was made against this bill
 * on paper, and this script has no payment date/method to safely reconstruct
 * an ApPayment row from a summary column alone, so it must never fabricate
 * one — and (b) the workbook's own ยอดค้างชำระ (L) matches the amount this
 * app would compute (amount + vat - wht - discount) within a 0.01 baht
 * rounding tolerance. A mismatch with nothing in G-K to explain it usually
 * means a transcription typo in the source sheet (a digit transposition,
 * etc.) — never silently adjusted; the row is skipped for manual entry
 * instead. Column N (จำนวนรวมจ่าย, the workbook's own "total paid so far"
 * tracker) is deliberately NOT part of this check — it is an independent,
 * sometimes-stale column the clerk doesn't reliably keep in sync with L/P
 * (see ap-seed.test.ts's "แมคโคร" case), so trusting it here would make the
 * integrity gate MORE likely to hide a real discrepancy, not less. */
export function checkRowIntegrity(input: RowIntegrityInput): RowIntegrityResult {
  const { amountBaht, vatBaht, whtBaht, discountBaht, outstandingBaht, depositBaht, installment1Baht, installment2Baht, installment3Baht } =
    input;

  const recordedPayments = depositBaht + installment1Baht + installment2Baht + installment3Baht;
  if (Math.abs(recordedPayments) > 0.005) {
    return {
      ok: false,
      reason: `workbook already records ${recordedPayments.toFixed(2)} baht paid (มัดจำ/งวด columns) — do not fabricate a payment record, enter manually`,
    };
  }

  const expectedOutstanding = amountBaht + vatBaht - whtBaht - discountBaht;
  const diff = Math.round((expectedOutstanding - outstandingBaht) * 100) / 100;
  if (Math.abs(diff) > 0.01) {
    return {
      ok: false,
      reason: `workbook ยอดค้างชำระ (${outstandingBaht.toFixed(2)}) does not match amount+vat-wht-discount (${expectedOutstanding.toFixed(2)}), diff ${diff.toFixed(2)} baht with nothing in G-K to explain it`,
    };
  }

  return { ok: true };
}

// ── due-date parsing (Buddhist-era Excel serial -> CE ISO date) ─────────

export type DueDateFlag = "clean" | "date-fixed" | "date-unparseable";

export interface DueDateResult {
  dueDate: string | null;
  flag: DueDateFlag;
}

function isValidCeDate(year: number, month: number, day: number): boolean {
  const d = new Date(Date.UTC(year, month - 1, day));
  return d.getUTCFullYear() === year && d.getUTCMonth() === month - 1 && d.getUTCDate() === day;
}

/** Mirrors src/server/server.ts's validateApRowInput year-range rule
 * (2000-2100) so a date this function accepts can never be rejected
 * downstream by the server's own validator — an unparseable/out-of-range
 * source value leaves dueDate blank rather than risk that. */
function isSaneYear(year: number): boolean {
  return year >= 2000 && year <= 2100;
}

export function parseSeedDueDate(raw: unknown): DueDateResult {
  if (raw === "" || raw === null || raw === undefined) {
    return { dueDate: null, flag: "clean" };
  }

  let serial: number | null = null;
  let hadToCoerce = false;

  if (typeof raw === "number" && Number.isFinite(raw)) {
    serial = raw;
  } else if (typeof raw === "string") {
    const cleaned = raw.trim();
    const n = Number(cleaned);
    if (cleaned !== "" && Number.isFinite(n)) {
      serial = n;
      hadToCoerce = true; // stored as text, not a native Excel serial
    }
  }

  if (serial === null) {
    return { dueDate: null, flag: "date-unparseable" };
  }

  const ce = excelSerialToCeDate(serial);
  if (!isSaneYear(ce.year) || !isValidCeDate(ce.year, ce.month, ce.day)) {
    return { dueDate: null, flag: "date-unparseable" };
  }

  const iso = `${ce.year}-${String(ce.month).padStart(2, "0")}-${String(ce.day).padStart(2, "0")}`;
  return { dueDate: iso, flag: hadToCoerce ? "date-fixed" : "clean" };
}

// ── note classification (drives the report's flag column) ──────────────

export interface NoteClassification {
  note: string;
  flags: string[];
}

const MONTH_MARKER_RE = /^เดือน\d+$/;

export function classifyNote(statusText: string): NoteClassification {
  if (statusText === "") return { note: "", flags: ["clean"] };
  if (MONTH_MARKER_RE.test(statusText)) return { note: statusText, flags: ["เดือนX-marked"] };
  if (statusText.includes("โทรตามยอด")) return { note: statusText, flags: ["chase-note"] };
  return { note: statusText, flags: ["note-other"] };
}

// ── row assembly ────────────────────────────────────────────────────────

export interface SeedRow {
  sourceRow: number;
  creditor: string;
  item: string;
  amountSatang: number;
  vatSatang: number | null;
  whtSatang: number | null;
  discountSatang: number;
  dueDate: string | null;
  entity: string;
  /** `SeedCategoryCode` for a row this file's own automatic
   * evaluateWorkbookRow scan produced (only ever one of the 3 mapped
   * families — never null, see resolveSeedCategory). Widened to
   * `ExpenseCategoryCode | null` so a HAND-CURATED seed batch (e.g.
   * scripts/seed-ap-2026-07b.ts, built outside this file's automatic
   * scan/mapping/integrity-check pipeline) can also produce a `SeedRow` —
   * RULING 1 (2026-07) made categoryCode optional on an AP row itself, and a
   * hand-picked row may deliberately carry no category yet. */
  categoryCode: ExpenseCategoryCode | null;
  note: string;
  flags: string[];
}

export interface SkippedRow {
  sourceRow: number;
  creditor: string;
  item: string;
  outstandingBaht: number;
  reason: string;
}

export type RowEvaluation = { kind: "seed"; row: SeedRow } | { kind: "skip"; row: SkippedRow } | { kind: "excluded" };

/** Evaluates one raw workbook data row (a plain array of cell values, e.g.
 * from XLSX's sheet_to_json({header: 1})) against the selection rule,
 * integrity check, and category mapping, in that order. Never throws — an
 * unmappable or malformed-but-selected row comes back as `{kind: "skip"}`
 * with a human-readable reason, for the owner's review table. */
export function evaluateWorkbookRow(row: readonly unknown[], sourceRow: number): RowEvaluation {
  const creditor = cellText(row, COL_CREDITOR);
  const item = cellText(row, COL_ITEM);
  if (creditor === "" && item === "") return { kind: "excluded" }; // blank spacer row

  const outstandingBaht = cellNumber(row, COL_OUTSTANDING);
  const statusText = cellText(row, COL_STATUS);
  if (!isOpenUnpaidRow(outstandingBaht, statusText)) return { kind: "excluded" };

  const amountBaht = cellNumber(row, COL_AMOUNT);
  const vatCell = cellRaw(row, COL_VAT);
  const whtCell = cellRaw(row, COL_WHT);
  const discountCell = cellRaw(row, COL_DISCOUNT);
  const vatBaht = isBlankCell(vatCell) ? 0 : toNumber(vatCell);
  const whtBaht = isBlankCell(whtCell) ? 0 : toNumber(whtCell);
  const discountBaht = isBlankCell(discountCell) ? 0 : toNumber(discountCell);

  const integrity = checkRowIntegrity({
    amountBaht,
    vatBaht,
    whtBaht,
    discountBaht,
    outstandingBaht,
    depositBaht: cellNumber(row, COL_DEPOSIT),
    installment1Baht: cellNumber(row, COL_INSTALLMENT_1),
    installment2Baht: cellNumber(row, COL_INSTALLMENT_2),
    installment3Baht: cellNumber(row, COL_INSTALLMENT_3),
  });
  if (!integrity.ok) {
    return { kind: "skip", row: { sourceRow, creditor, item, outstandingBaht, reason: integrity.reason! } };
  }

  const categoryCode = resolveSeedCategory(creditor, item);
  if (!categoryCode) {
    return {
      kind: "skip",
      row: {
        sourceRow,
        creditor,
        item,
        outstandingBaht,
        reason: `no category mapping defined for creditor "${creditor}" (only Booking.com / expedia group / บุญดี /ของใช้แม่บ้าน are mapped) — categorize and enter manually`,
      },
    };
  }

  const entity = cellText(row, COL_ENTITY);
  const due = parseSeedDueDate(cellRaw(row, COL_DUE));
  const noteInfo = classifyNote(statusText);
  const flags = [...noteInfo.flags];
  if (due.flag !== "clean") flags.push(due.flag);

  return {
    kind: "seed",
    row: {
      sourceRow,
      creditor,
      item,
      amountSatang: amountToMinorUnits(amountBaht),
      vatSatang: isBlankCell(vatCell) ? null : amountToMinorUnits(vatBaht),
      whtSatang: isBlankCell(whtCell) ? null : amountToMinorUnits(whtBaht),
      discountSatang: isBlankCell(discountCell) ? 0 : amountToMinorUnits(discountBaht),
      dueDate: due.dueDate,
      entity,
      categoryCode,
      note: noteInfo.note,
      flags,
    },
  };
}

/** Projects a SeedRow down to exactly the fields src/server/server.ts's
 * validateApRowInput / apStore.createApRow expect — `sourceRow` and `flags`
 * are report-only and must never reach the store. */
export function toApRowInput(row: SeedRow): ApRowInput {
  return {
    creditor: row.creditor,
    item: row.item,
    amountSatang: row.amountSatang,
    vatSatang: row.vatSatang,
    whtSatang: row.whtSatang,
    discountSatang: row.discountSatang,
    dueDate: row.dueDate,
    entity: row.entity,
    categoryCode: row.categoryCode,
    note: row.note,
  };
}
