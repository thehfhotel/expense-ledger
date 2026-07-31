// localStorage keys — frontend spec §9: `expense.draft`, `expense.pay`,
// `expense.recent`. Every read/write is wrapped so a private-mode browser
// (localStorage throws) degrades to "nothing persists", never a crash.

import { isExpenseCategoryCode, type ExpenseCategoryCode } from "../shared/categories.ts";
import type { PaymentMethod } from "../shared/types.ts";

const DRAFT_KEY = "expense.draft";
const PAY_KEY = "expense.pay";
const RECENT_KEY = "expense.recent";
const RECENT_LIMIT = 5;

/** The in-progress entry form, mirrored on every change and restored on
 * load (frontend spec §6 "Draft preservation") — this is what makes both
 * the engine-unreachable and session-expired error states non-destructive
 * across a reload. */
export interface DraftState {
  date: string;
  amountText: string;
  categoryCode: ExpenseCategoryCode | null;
  paymentMethod: PaymentMethod;
  comment: string;
}

export function loadDraft(): DraftState | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<DraftState>;
    if (typeof parsed.date !== "string" || typeof parsed.amountText !== "string") return null;
    return {
      date: parsed.date,
      amountText: parsed.amountText,
      categoryCode: isExpenseCategoryCode(parsed.categoryCode) ? parsed.categoryCode : null,
      paymentMethod: parsed.paymentMethod === "bank" ? "bank" : "cash",
      comment: typeof parsed.comment === "string" ? parsed.comment : "",
    };
  } catch {
    return null;
  }
}

export function saveDraft(draft: DraftState): void {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  } catch {
    /* private mode / storage full — the draft simply won't survive a reload */
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* nothing to clear if storage never worked */
  }
}

/** Default "เงินสด" — binary and always visible, per frontend spec §2.4. */
export function loadPaymentMethod(): PaymentMethod {
  try {
    return localStorage.getItem(PAY_KEY) === "bank" ? "bank" : "cash";
  } catch {
    return "cash";
  }
}

export function savePaymentMethod(method: PaymentMethod): void {
  try {
    localStorage.setItem(PAY_KEY, method);
  } catch {
    /* not persisted this session */
  }
}

/** Up to 5 pills, most-recent first — frontend spec §2.3 "ล่าสุด". Hidden on
 * first run (an empty array). */
export function loadRecentCategories(): ExpenseCategoryCode[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter(isExpenseCategoryCode).slice(0, RECENT_LIMIT) : [];
  } catch {
    return [];
  }
}

export function pushRecentCategory(code: ExpenseCategoryCode): ExpenseCategoryCode[] {
  const next = [code, ...loadRecentCategories().filter((c) => c !== code)].slice(0, RECENT_LIMIT);
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* not persisted this session */
  }
  return next;
}
