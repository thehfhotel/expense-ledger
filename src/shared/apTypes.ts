// AP register ("ค้างจ่าย") wire types + pure domain functions — see
// docs/ap-tab-spec (design spec) for the full UX rationale. Money is integer
// satang, dates are Bangkok calendar ISO "YYYY-MM-DD" strings, same
// conventions as src/shared/types.ts. This file has no side effects and only
// imports other shared/ modules, so client and server share the EXACT same
// arithmetic/status/derivation logic — never re-derived differently in two
// places (spec §9: "grossSatang and outstandingSatang are computed
// server-side and sent ... the client recomputes only for the live preview
// inside the drawer").

import type { ExpenseCategoryCode } from "./categories.ts";
import { shiftDays } from "./date.ts";
import type { PaymentMethod } from "./types.ts";

export type ApPaymentKind = "deposit" | "installment" | "full";

/** One recorded payment against an ApRow. `transactionId` is the id of the
 * ordinary expense transaction this payment posted through the engine
 * (orchestrator ruling #3) — undo (DELETE .../payments/:pid) deletes exactly
 * that transaction, never a re-derived one. */
export interface ApPayment {
  id: string;
  date: string;
  amountSatang: number;
  paymentMethod: PaymentMethod;
  kind: ApPaymentKind;
  /** Set only when kind === "installment" (1-based, counted from the first
   * partial AFTER the deposit) — see derivePaymentKind. */
  installmentNumber: number | null;
  payerEmail: string;
  transactionId: string;
}

export interface ApRow {
  id: string;
  creditor: string;
  item: string;
  amountSatang: number;
  vatSatang: number | null;
  whtSatang: number | null;
  discountSatang: number;
  dueDate: string | null;
  entity: string;
  /** RULING 1 (2026-07): optional — a row can be filed before its category
   * is known (an explicit "ไม่ระบุหมวด" state, never a hidden default; see
   * src/client/components/ApRowDrawer.tsx). A PAYMENT against the row still
   * always needs a real category (every engine transaction must have one) —
   * see paymentNeedsCategoryPicker below and src/server/server.ts's payment
   * route, which requires and persists one back onto the row the first time
   * it's paid. */
  categoryCode: ExpenseCategoryCode | null;
  note: string;
  /** ISO 8601 datetime (UTC, not just a date) — used ONLY as the final
   * insertion-order sort tiebreaker (ApPage.tsx's sortRows). M1 fix: the
   * month-filter fallback used to slice THIS field, which put a row created
   * 00:00-07:00 Bangkok on the 1st into the previous month (UTC's calendar
   * date at that moment is still the prior month's last day); that fallback
   * now runs server-side against apStore.ts's own `filed_date` (a Bangkok
   * calendar date), which this interface never needs to expose. */
  createdAt: string;
  createdBy: string;
  /** The newest payment's date once outstanding <= 0, else null — the
   * "จ่ายแล้ว {date}" label (spec §3, §6). Computed at read time from
   * `payments`, never stored, so it can never drift from what it summarizes
   * — see deriveSettledAt. */
  settledAt: string | null;
  /** = amountSatang + (vatSatang ?? 0) - (whtSatang ?? 0), computed
   * server-side and sent — never re-derived differently in two places. */
  grossSatang: number;
  /** = grossSatang - Σ payments - discountSatang, computed server-side. */
  outstandingSatang: number;
  payments: ApPayment[];
}

export type ApFilterMode = "open" | "all" | "month";

export interface ApListFilter {
  mode: ApFilterMode;
  /** Present only when mode === "month" (validated "YYYY-MM"). */
  month?: string;
}

/** Server-supplied autocomplete hint: the most recent row filed under this
 * creditor, so picking a known creditor can prefill หมวดค่าใช้จ่าย/ในนาม
 * (spec §4 item 1). */
export interface ApCreditorHint {
  creditor: string;
  categoryCode: ExpenseCategoryCode | null;
  entity: string;
}

export interface ApSummary {
  totalOutstandingSatang: number;
  overdueCount: number;
}

/** GET /api/ap/rows response (spec §9). */
export interface ApRowsResponse {
  rows: ApRow[];
  summary: ApSummary;
  creditors: ApCreditorHint[];
}

/** Body shared by POST /api/ap/rows and PATCH /api/ap/rows/:id. */
export interface ApRowInput {
  creditor: string;
  item: string;
  amountSatang: number;
  vatSatang: number | null;
  whtSatang: number | null;
  discountSatang: number;
  dueDate: string | null;
  entity: string;
  categoryCode: ExpenseCategoryCode | null;
  note: string;
}

export interface ApPaymentInput {
  date: string;
  amountSatang: number;
  paymentMethod: PaymentMethod;
  /** RULING 1: required ONLY when the row being paid currently has a null
   * categoryCode — the server re-derives whether it's required from the
   * row's own state (never trusts a client-sent flag) and, when supplied,
   * persists it back onto the row inside the same write-lock critical
   * section as the payment insert. Omitted/ignored when the row already has
   * a category. */
  categoryCode?: ExpenseCategoryCode;
}

export interface CreateApRowResponse {
  id: string;
}

export interface CreateApPaymentResponse {
  paymentId: string;
  transactionId: string;
}

// ── Arithmetic ──────────────────────────────────────────────────────────

export function computeGross(amountSatang: number, vatSatang: number | null, whtSatang: number | null): number {
  return amountSatang + (vatSatang ?? 0) - (whtSatang ?? 0);
}

export function computeOutstanding(
  grossSatang: number,
  payments: readonly { amountSatang: number }[],
  discountSatang: number,
): number {
  const paid = payments.reduce((sum, p) => sum + p.amountSatang, 0);
  return grossSatang - paid - discountSatang;
}

/** The newest payment's date once outstanding <= 0, else null (spec §3, §6
 * "A row settled by an edit flips to จ่ายครบ with settledAt = the newest
 * payment's date"). Computed, never stored.
 *
 * H3 fix: a row can be settled with ZERO payments — a discount or WHT alone
 * brings outstanding to <= 0 at creation time (the credit-note case; create
 * only rejects outstanding < 0, never === 0, and that's deliberate — spec
 * §4). Such a row has no payment date to report, so this falls back to
 * `filedDate` (the row's own Bangkok filing date, src/server/apStore.ts's
 * `filed_date` column) instead of returning null — the previous null return
 * here is exactly what made ApPage.tsx's `isoToBuddhist(row.settledAt!)`
 * throw a white screen for these rows. `filedDate` is optional so existing
 * 2-arg callers (and this file's own tests) keep returning null when no
 * fallback is available. */
export function deriveSettledAt(
  payments: readonly { date: string }[],
  outstandingSatang: number,
  filedDate?: string,
): string | null {
  if (outstandingSatang > 0) return null;
  if (payments.length === 0) return filedDate ?? null;
  return payments.reduce((latest, p) => (p.date > latest ? p.date : latest), payments[0]!.date);
}

// ── Status derivation (spec §3 "Status derivation") ────────────────────────

export type ApStatus = "settled" | "overdue" | "dueSoon" | "open";

const STATUS_RANK: Record<ApStatus, number> = { overdue: 0, dueSoon: 1, open: 2, settled: 3 };

/** เกินกำหนด 0, ใกล้ครบกำหนด 1, ค้างจ่าย 2, จ่ายครบ 3 — the register's fixed
 * sort key (spec §3 "Overdue emphasis + sort"). */
export function statusRank(status: ApStatus): number {
  return STATUS_RANK[status];
}

/**
 * `today` and `dueDate` are Bangkok calendar ISO dates (src/shared/date.ts).
 * Order matters: settled beats every date rule (a row can be both overdue by
 * date AND fully paid — settled wins), then overdue, then the 7-day
 * ใกล้ครบกำหนด window (inclusive both ends), else ค้างจ่าย — including a
 * blank due date, per the spec's table exactly.
 */
export function deriveStatus(dueDate: string | null, outstandingSatang: number, today: string): ApStatus {
  if (outstandingSatang <= 0) return "settled";
  if (dueDate === null) return "open";
  if (dueDate < today) return "overdue";
  if (dueDate <= shiftDays(today, 7)) return "dueSoon";
  return "open";
}

// ── Payment kind derivation (spec §5 "Payment kind is derived, never chosen") ─

export interface DerivedPaymentKind {
  kind: ApPaymentKind;
  installmentNumber: number | null;
}

/**
 * `settles` = whether THIS payment would bring outstanding to <= 0 — the
 * caller (src/server/server.ts) decides that from the row's current
 * outstanding balance and the amount being posted, never a client-chosen
 * kind. First partial -> มัดจำ; later partials -> งวดที่ N, N counted from 1
 * starting after the deposit (a settling payment is always "full" regardless
 * of what came before).
 */
export function derivePaymentKind(existingPayments: readonly ApPayment[], settles: boolean): DerivedPaymentKind {
  if (settles) return { kind: "full", installmentNumber: null };
  const hasDeposit = existingPayments.some((p) => p.kind === "deposit" || p.kind === "installment");
  if (!hasDeposit) return { kind: "deposit", installmentNumber: null };
  const installmentCount = existingPayments.filter((p) => p.kind === "installment").length;
  return { kind: "installment", installmentNumber: installmentCount + 1 };
}

// ── RULING 1: payment category requirement (2026-07) ────────────────────

/** Whether recording a payment against a row with this categoryCode must
 * collect a category from the clerk first — true iff the row itself has no
 * category yet. Shared so the client's ApPaymentForm (which decides whether
 * to render the 21-leaf CategoryPicker at all) and src/server/server.ts's
 * payment route (which decides whether to require/persist one) apply the
 * EXACT same rule, never two independently-drifting copies. A row that
 * already carries a category keeps the pre-ruling behavior — no picker, no
 * server-side requirement. */
export function paymentNeedsCategoryPicker(rowCategoryCode: ExpenseCategoryCode | null): boolean {
  return rowCategoryCode === null;
}

/** `ap:<rowId>` — the ezBookkeeping tag every posted payment for this row
 * carries (orchestrator ruling #3), mirroring scripts/import-workbook.ts's
 * `import:<YYYY-MM>` idempotency-tag pattern. Shared so both the poster
 * (src/server/engine.ts) and its tests use the exact same literal format. */
export function apTagName(rowId: string): string {
  return `ap:${rowId}`;
}

/** `" (มัดจำ)"` / `" (งวดที่ N)"` for a partial payment, `""` for a full
 * settlement — split out from buildApPaymentComment (L3 fix) so
 * src/server/server.ts's truncation step can shrink the "<creditor> -
 * <รายการ>" prefix ALONE to fit the engine's comment-length budget while
 * always keeping this marker intact. A generic end-trim would cut this
 * suffix first, since buildApPaymentComment appends it as the FINAL
 * characters — silently losing which installment a payment was. */
export function paymentKindSuffix(kind: ApPaymentKind, installmentNumber: number | null): string {
  return kind === "deposit" ? " (มัดจำ)" : kind === "installment" ? ` (งวดที่ ${installmentNumber})` : "";
}

/**
 * `"<ชื่อเจ้าหนี้> - <รายการ>"` suffixed `" (มัดจำ)"` / `" (งวดที่ N)"` for a
 * partial payment, plain for a full settlement (spec §5 "Ledger posting").
 * Truncation for the engine's comment-length budget happens server-side
 * (src/server/server.ts) — this only composes the ideal, untruncated text.
 */
export function buildApPaymentComment(
  creditor: string,
  item: string,
  kind: ApPaymentKind,
  installmentNumber: number | null,
): string {
  return `${creditor} - ${item}${paymentKindSuffix(kind, installmentNumber)}`;
}
