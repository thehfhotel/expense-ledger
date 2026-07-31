import type { CategoriesConfig } from "./categories-config.ts";
import { EXPENSE_COLUMNS } from "./columns.ts";

export interface ResolvedColumnCategory {
  code: string;
  label: string;
  secondaryLabel: string;
}

/**
 * Resolves a workbook column letter (e.g. "I") to the primary/secondary
 * category it maps to, per the fixed EXPENSE_COLUMNS table joined against
 * the live categories.json secondaries ordering. Returns undefined if the
 * column isn't a mapped expense column, or if categories.json is missing the
 * primary/secondary the column expects (a config error, not a workbook one).
 */
export function resolveColumnCategory(column: string, categories: CategoriesConfig): ResolvedColumnCategory | undefined {
  const entry = EXPENSE_COLUMNS.find((e) => e.column === column);
  if (!entry) return undefined;

  const primary = categories.primaries.find((p) => p.code === entry.code);
  if (!primary) return undefined;

  const secondaryLabel = primary.secondaries[entry.secondaryIndex];
  if (secondaryLabel === undefined) return undefined;

  return { code: primary.code, label: primary.label, secondaryLabel };
}

/**
 * Picks the daily HF property sheet out of a workbook's sheet name list.
 * This workbook family names it something like "ก.ค.-69- HF" (Thai
 * abbreviated month + Buddhist year + " HF" suffix) alongside a same-shaped
 * HF Ville sheet (ends in "HF Ville", out of scope here), one or more P&L
 * summary sheets (start with "งบ"), and the itemized "ค่าใช้จ่าย" sheet.
 * The rule: exactly one sheet name should end with "HF" (not "HF Ville")
 * and not start with "งบ".
 */
export function findDailySheetName(sheetNames: string[]): string {
  const candidates = sheetNames.filter((name) => {
    const trimmed = name.trim();
    return trimmed.endsWith("HF") && !trimmed.startsWith("งบ");
  });

  if (candidates.length !== 1) {
    throw new Error(
      `expected exactly one daily HF sheet (name ending in "HF", excluding P&L "งบ..." sheets); found ${candidates.length}: ${JSON.stringify(candidates)}. Pass --sheet <name> to override.`,
    );
  }

  return candidates[0]!;
}
