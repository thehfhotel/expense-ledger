// Wire contract types shared by client and server — see frontend spec §9
// "Client-assumed API". Money is integer satang end to end (src/shared/
// money.ts); dates are Bangkok calendar "YYYY-MM-DD" strings (src/shared/
// date.ts). No `name_en`, no in-app roles — see CLAUDE.md.

import type { ExpenseCategoryCode } from "./categories.ts";

export type PaymentMethod = "cash" | "bank";

export function isPaymentMethod(v: unknown): v is PaymentMethod {
  return v === "cash" || v === "bank";
}

export interface Me {
  email: string;
}

/** GET /api/categories — static leaf metadata (see categories.ts); never a
 * numeric engine id. */
export interface CategoryListItem {
  code: ExpenseCategoryCode;
  label: string;
  building?: string;
  recurring: boolean;
  order: number;
}

export interface ExpensePhoto {
  id: string;
  url: string;
}

/**
 * One expense transaction as the client sees it. `comment` is always the
 * DISPLAY text (the attribution token already stripped server-side — see
 * src/server/attribution.ts); `by` is the last-writer email, surfaced as its
 * own field, never embedded in `comment`. `by` is `null` for a legacy row
 * that carries no attribution token.
 */
export interface ExpenseTransaction {
  id: string;
  date: string;
  amountSatang: number;
  categoryCode: ExpenseCategoryCode;
  paymentMethod: PaymentMethod;
  comment: string;
  by: string | null;
  photos: ExpensePhoto[];
}

export interface CategoryTotal {
  count: number;
  amountSatang: number;
}

/** GET /api/expenses?month=YYYY-MM */
export interface MonthExpensesResponse {
  items: ExpenseTransaction[];
  totalsByCategory: Partial<Record<ExpenseCategoryCode, CategoryTotal>>;
  totalSatang: number;
}

/** Body shape shared by POST /api/expenses and PATCH /api/expenses/:id.
 * `comment` is the clerk's raw text — the server appends/re-appends the
 * attribution token; the client never sends or renders it (§5). */
export interface ExpenseInput {
  date: string;
  amountSatang: number;
  categoryCode: ExpenseCategoryCode;
  paymentMethod: PaymentMethod;
  comment: string;
}

export interface CreateExpenseResponse {
  id: string;
}

export interface UploadPhotoResponse {
  id: string;
  url: string;
}

// ── Server-enforced bounds ────────────────────────────────────────────────
export const COMMENT_MAX_LEN = 200;
export const AMOUNT_SATANG_MIN = 1;
export const AMOUNT_SATANG_MAX = 99_999_999_999;
