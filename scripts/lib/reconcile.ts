import { amountToMinorUnits } from "./currency.ts";

export interface ReconciliationRow {
  categoryKey: string;
  label: string;
  workbookTotalMajor: number;
  engineTotalMinor: number;
  diffMinor: number;
  ok: boolean;
}

/**
 * Compares workbook รวม totals (major units, baht, as floats) against
 * engine-recomputed totals (minor units, satang, as integers) per category
 * key. Workbook totals are rounded to minor units before comparing, so a
 * genuine zero diff isn't reported as nonzero due to float noise.
 */
export function buildReconciliation(
  workbookTotalsMajor: Map<string, number>,
  engineTotalsMinor: Map<string, number>,
  labels: Map<string, string>,
): ReconciliationRow[] {
  const keys = new Set<string>([...workbookTotalsMajor.keys(), ...engineTotalsMinor.keys()]);
  const rows: ReconciliationRow[] = [];

  for (const key of keys) {
    const workbookTotalMajor = workbookTotalsMajor.get(key) ?? 0;
    const workbookMinor = amountToMinorUnits(workbookTotalMajor);
    const engineTotalMinor = engineTotalsMinor.get(key) ?? 0;
    const diffMinor = engineTotalMinor - workbookMinor;

    rows.push({
      categoryKey: key,
      label: labels.get(key) ?? key,
      workbookTotalMajor,
      engineTotalMinor,
      diffMinor,
      ok: diffMinor === 0,
    });
  }

  return rows.sort((a, b) => a.label.localeCompare(b.label));
}

export function reconciliationPassed(rows: ReconciliationRow[]): boolean {
  return rows.every((r) => r.ok);
}
