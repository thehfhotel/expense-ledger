// Types for scripts/categories.json - the canonical expense chart used by
// both seed.ts (creates categories/accounts) and import-workbook.ts (maps
// workbook columns to secondary categories). Kept separate from the JSON
// file itself so tests can build small in-memory fixtures without touching
// the real canonical data.

export interface PrimaryCategoryConfig {
  /** Stable code, matches a column mapping entry in lib/columns.ts. */
  code: string;
  /** Thai label - this is the category NAME sent to the engine. */
  label: string;
  /** ezBookkeeping category icon id (see ALL_CATEGORY_ICONS upstream). */
  icon: string;
  /** 6-digit hex color, no leading '#' (engine's validHexRGBColor rule). */
  color: string;
  /**
   * Secondary category labels under this primary, in a fixed order that
   * lib/columns.ts's EXPENSE_COLUMNS indexes into by position. Transactions
   * only ever attach to a secondary - the engine forbids posting to a
   * category that itself has children.
   */
  secondaries: string[];
}

export type AccountCategoryKind = "cash" | "checking";

export interface AccountConfig {
  name: string;
  category: AccountCategoryKind;
  icon: string;
  color: string;
}

export interface CategoriesConfig {
  primaries: PrimaryCategoryConfig[];
  accounts: AccountConfig[];
}
