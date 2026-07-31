import { amountToMinorUnits } from "./currency.ts";
import { BANGKOK_UTC_OFFSET_MINUTES, bangkokNoonUnixSeconds } from "./dates.ts";
import type { DailyRow } from "./workbook.ts";

export const IMPORT_COMMENT_PREFIX = "นำเข้าจาก Excel";

export interface PlannedTransaction {
  rowNumber: number;
  column: string;
  code: string;
  secondaryLabel: string;
  /** Stable join key for reconciliation and category lookups: "code::secondaryLabel". */
  categoryKey: string;
  unixTime: number;
  utcOffsetMinutes: number;
  amountMinorUnits: number;
  comment: string;
}

export function categoryKey(code: string, secondaryLabel: string): string {
  return `${code}::${secondaryLabel}`;
}

/**
 * Builds one planned transaction per non-empty, non-zero expense cell.
 * Comment placement: every transaction gets "นำเข้าจาก Excel"; the day's
 * Z-column note (if any) is appended ONLY to that day's first transaction
 * (in column order), never repeated across the rest of the day's
 * transactions - this is a workbook date-level annotation, not a per-cell
 * one, so attaching it to every transaction on the day would duplicate it.
 * A day with a note but zero non-zero expense cells simply has nowhere to
 * attach it (no transaction is created for the day at all).
 */
export function buildPlannedTransactions(dailyRows: DailyRow[]): PlannedTransaction[] {
  const planned: PlannedTransaction[] = [];

  for (const day of dailyRows) {
    const unixTime = bangkokNoonUnixSeconds(day.date);
    let noteAttached = false;

    for (const cell of day.cells) {
      const attachNote = !noteAttached && day.note !== "";
      const comment = attachNote ? `${IMPORT_COMMENT_PREFIX} - ${day.note}` : IMPORT_COMMENT_PREFIX;
      if (attachNote) noteAttached = true;

      planned.push({
        rowNumber: day.rowNumber,
        column: cell.column,
        code: cell.code,
        secondaryLabel: cell.secondaryLabel,
        categoryKey: categoryKey(cell.code, cell.secondaryLabel),
        unixTime,
        utcOffsetMinutes: BANGKOK_UTC_OFFSET_MINUTES,
        amountMinorUnits: amountToMinorUnits(cell.amountMajor),
        comment,
      });
    }
  }

  return planned;
}

export interface PlanSummaryRow {
  categoryKey: string;
  label: string;
  count: number;
  amountMinorUnits: number;
}

/** Groups planned transactions by category for a compact pre-import plan printout. */
export function summarizePlan(planned: PlannedTransaction[], labels: Map<string, string>): PlanSummaryRow[] {
  const byKey = new Map<string, PlanSummaryRow>();

  for (const t of planned) {
    const existing = byKey.get(t.categoryKey);

    if (existing) {
      existing.count++;
      existing.amountMinorUnits += t.amountMinorUnits;
    } else {
      byKey.set(t.categoryKey, {
        categoryKey: t.categoryKey,
        label: labels.get(t.categoryKey) ?? t.categoryKey,
        count: 1,
        amountMinorUnits: t.amountMinorUnits,
      });
    }
  }

  return [...byKey.values()].sort((a, b) => a.label.localeCompare(b.label));
}
