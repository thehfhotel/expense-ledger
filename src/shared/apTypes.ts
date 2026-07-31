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
  categoryCode: ExpenseCategoryCode;
  note: string;
  /** ISO 8601 datetime (not just a date) — used as the "created month"
   * fallback for month filtering and as the final sort tiebreaker. */
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
  categoryCode: ExpenseCategoryCode;
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
  categoryCode: ExpenseCategoryCode;
  note: string;
}

export interface ApPaymentInput {
  date: string;
  amountSatang: number;
  paymentMethod: PaymentMethod;
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
 * payment's date"). Computed, never stored. */
export function deriveSettledAt(payments: readonly { date: string }[], outstandingSatang: number): string | null {
  if (outstandingSatang > 0 || payments.length === 0) return null;
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

/** `ap:<rowId>` — the ezBookkeeping tag every posted payment for this row
 * carries (orchestrator ruling #3), mirroring scripts/import-workbook.ts's
 * `import:<YYYY-MM>` idempotency-tag pattern. Shared so both the poster
 * (src/server/engine.ts) and its tests use the exact same literal format. */
export function apTagName(rowId: string): string {
  return `ap:${rowId}`;
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
  const suffix = kind === "deposit" ? " (มัดจำ)" : kind === "installment" ? ` (งวดที่ ${installmentNumber})` : "";
  return `${creditor} - ${item}${suffix}`;
}
