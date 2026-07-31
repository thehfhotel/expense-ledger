// The 21 expense-category leaves, flattened from the paper sheet's
// (sometimes two-level) chart into one flat list — see the frontend spec
// §2.3 "Decision: flatten the two-level chart to all 21 leaves in one grid".
//
// This is the ONE source for the leaf list: the client's category picker
// reads `label`/`building`/`order` for the tile grid, the month view's
// checklist reads `recurring`, and the server's category-id map
// (src/server/categoryEngineMap.ts) reads `code` to resolve each leaf to an
// ezBookkeeping secondary-category id at runtime — never a hardcoded
// numeric id anywhere in the client.
//
// Order is the paper sheet's; preserve it exactly, including the fact that
// water and electricity list their buildings in different orders (water:
// สายชล, Hop inn 47, HF Ville; electricity: สายชล, HF Ville, Hop inn 47).

export type ExpenseCategoryCode =
  | "salary"
  | "commission-staff"
  | "commission-booking"
  | "commission-expedia"
  | "breakfast"
  | "housekeeping"
  | "water-bar"
  | "repair-appliance"
  | "water-utility-saichon"
  | "water-utility-hopinn47"
  | "water-utility-ville"
  | "electricity-saichon"
  | "electricity-ville"
  | "electricity-hopinn47"
  | "phone-saichon"
  | "phone-ville"
  | "laundry"
  | "repair-building"
  | "supplies"
  | "social-security"
  | "other";

export interface ExpenseCategory {
  code: ExpenseCategoryCode;
  /** 1-based position in the paper sheet's order — the grid, the checklist
   * and the totals table all iterate this order, never re-sort. */
  order: number;
  label: string;
  /** Second tile line for a building-scoped leaf (water/electricity/phone);
   * undefined for every other leaf. */
  building?: string;
  /** True for the 17 leaves that belong on every month's recurring
   * checklist (frontend spec §3.1). */
  recurring: boolean;
}

export const EXPENSE_CATEGORIES: readonly ExpenseCategory[] = [
  { code: "salary", order: 1, label: "เงินเดือนพนักงาน", recurring: true },
  { code: "commission-staff", order: 2, label: "ค่าคอมมิชชั่นพนักงาน", recurring: true },
  { code: "commission-booking", order: 3, label: "ค่าคอมมิชชั่น BOOKING", recurring: true },
  { code: "commission-expedia", order: 4, label: "ค่าคอมมิชชั่น expedia group", recurring: true },
  { code: "breakfast", order: 5, label: "ค่าอาหารเช้า", recurring: true },
  { code: "housekeeping", order: 6, label: "ค่าใช้จ่าย-แม่บ้าน", recurring: true },
  { code: "water-bar", order: 7, label: "ค่าใช้จ่าย-บาร์น้ำ", recurring: true },
  { code: "repair-appliance", order: 8, label: "ค่าซ่อมแซม-เครื่องใช้ไฟฟ้า", recurring: false },
  { code: "water-utility-saichon", order: 9, label: "ค่าน้ำประปา", building: "สายชล", recurring: true },
  { code: "water-utility-hopinn47", order: 10, label: "ค่าน้ำประปา", building: "Hop inn 47", recurring: true },
  { code: "water-utility-ville", order: 11, label: "ค่าน้ำประปา", building: "HF Ville", recurring: true },
  { code: "electricity-saichon", order: 12, label: "ค่าไฟฟ้า", building: "สายชล", recurring: true },
  { code: "electricity-ville", order: 13, label: "ค่าไฟฟ้า", building: "HF Ville", recurring: true },
  { code: "electricity-hopinn47", order: 14, label: "ค่าไฟฟ้า", building: "Hop inn 47", recurring: true },
  { code: "phone-saichon", order: 15, label: "ค่าโทรศัพท์", building: "สายชล+ออฟฟิต", recurring: true },
  { code: "phone-ville", order: 16, label: "ค่าโทรศัพท์", building: "HF Ville", recurring: true },
  { code: "laundry", order: 17, label: "ค่าซักผ้า", recurring: true },
  { code: "repair-building", order: 18, label: "ค่าซ่อมแซม-อาคาร", recurring: false },
  { code: "supplies", order: 19, label: "ค่าวัสดุสิ้นเปลือง/อุปกรณ์สำนักงาน", recurring: false },
  { code: "social-security", order: 20, label: "ค่าเงินสมทบประกันสังคม", recurring: true },
  { code: "other", order: 21, label: "ค่าใช้จ่ายอื่นๆ", recurring: false },
] as const;

export const EXPENSE_CATEGORY_CODES: readonly ExpenseCategoryCode[] = EXPENSE_CATEGORIES.map((c) => c.code);

export const RECURRING_CATEGORY_CODES: readonly ExpenseCategoryCode[] = EXPENSE_CATEGORIES.filter(
  (c) => c.recurring,
).map((c) => c.code);

export const RECURRING_CATEGORY_COUNT = RECURRING_CATEGORY_CODES.length;

export function isExpenseCategoryCode(v: unknown): v is ExpenseCategoryCode {
  return typeof v === "string" && EXPENSE_CATEGORY_CODES.includes(v as ExpenseCategoryCode);
}

const BY_CODE = new Map(EXPENSE_CATEGORIES.map((c) => [c.code, c]));

export function categoryByCode(code: ExpenseCategoryCode): ExpenseCategory {
  const category = BY_CODE.get(code);
  if (!category) throw new Error(`unknown expense category code: ${code}`);
  return category;
}

/** Codes 9-16 (the water/electricity/phone building-scoped leaves) get a
 * category-aware item placeholder that captures the billing month — see
 * frontend spec §2.5. */
export function isBillingMonthCategory(code: ExpenseCategoryCode): boolean {
  const category = categoryByCode(code);
  return category.order >= 9 && category.order <= 16;
}
