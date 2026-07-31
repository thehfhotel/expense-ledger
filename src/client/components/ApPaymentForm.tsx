import { useEffect, useRef, useState } from "react";
import { createApPayment, EngineUnreachableError, SessionExpiredError } from "../api.ts";
import { currentMonthBangkok, isoToThaiLong, todayBangkok } from "../../shared/date.ts";
import { formatSatang, parseAmountToSatang } from "../../shared/money.ts";
import { paymentNeedsCategoryPicker, type ApRow } from "../../shared/apTypes.ts";
import type { ExpenseCategoryCode } from "../../shared/categories.ts";
import type { PaymentMethod } from "../../shared/types.ts";
import { CategoryPicker } from "./CategoryPicker.tsx";
import {
  AP_FIELDS,
  AP_PAY,
  AP_VALIDATION,
  ENGINE_ERROR,
  FIELD_LABELS,
  PAST_MONTH_LOCK,
  PAYMENT_METHOD_LABELS,
  VALIDATION,
} from "../labels.ts";
import { loadPaymentMethod, loadRecentCategories, savePaymentMethod } from "../storage.ts";

interface Props {
  row: ApRow;
  onClose: () => void;
  /** `dateIso` is the date the payment actually posted on. `categoryCode` is
   * the category the payment ACTUALLY posted under — RULING 1 (2026-07):
   * the row's own categoryCode can be null (that's exactly when this form
   * renders its own picker), so this is never re-derived from `row` by the
   * caller; it's always the row's pre-existing category, or the one this
   * form just collected and had persisted onto the row. Callers use it to
   * compose spec §5's "ลงบัญชีในหมวด ... แล้ว" confirmation, or ignore it and
   * just refetch/flash the row. */
  onPosted: (dateIso: string, categoryCode: ExpenseCategoryCode) => void;
}

/**
 * The บันทึกการชำระ popover (spec §5) — a compact overlay, never a full
 * page. Triggered from the row's ชำระ button or from inside ApRowDrawer;
 * either way this is the SAME component so the two clicks-to-record-a-
 * payment path is identical regardless of entry point.
 */
export function ApPaymentForm({ row, onClose, onPosted }: Props) {
  const [date, setDate] = useState(todayBangkok());
  const [amountText, setAmountText] = useState((row.outstandingSatang / 100).toFixed(2));
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(loadPaymentMethod());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // RULING 1 (2026-07): a row can carry no category yet, but every posted
  // payment still must — this form collects one, right here, the FIRST time
  // such a row is paid (same 21-leaf picker as the entry page). A row that
  // already has a category never shows this at all — pre-ruling behavior,
  // unchanged.
  const needsCategoryPicker = paymentNeedsCategoryPicker(row.categoryCode);
  const [pickedCategoryCode, setPickedCategoryCode] = useState<ExpenseCategoryCode | null>(null);
  const recentCodes = useState(() => loadRecentCategories())[0];

  const dateInputRef = useRef<HTMLInputElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = dateInputRef.current;
    if (!el) return;
    const commit = () => {
      if (el.value && el.value !== date) setDate(el.value);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, [date]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function payFull() {
    setAmountText((row.outstandingSatang / 100).toFixed(2));
  }

  async function handleSubmit() {
    const amountSatang = parseAmountToSatang(amountText);
    if (amountSatang === null || amountSatang <= 0) {
      setError(VALIDATION.amountInvalid);
      amountInputRef.current?.focus();
      return;
    }
    if (amountSatang > row.outstandingSatang) {
      setError(AP_VALIDATION.payTooMuch);
      amountInputRef.current?.focus();
      return;
    }
    if (needsCategoryPicker && pickedCategoryCode === null) {
      setError(AP_VALIDATION.categoryRequiredForPayment);
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await createApPayment(row.id, {
        date,
        amountSatang,
        paymentMethod,
        ...(needsCategoryPicker ? { categoryCode: pickedCategoryCode! } : {}),
      });
      savePaymentMethod(paymentMethod);
      onPosted(date, row.categoryCode ?? pickedCategoryCode!);
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      if (err instanceof EngineUnreachableError) {
        setError(ENGINE_ERROR.message);
      } else if (err instanceof Error && err.message === "date must be in the current month") {
        setError(PAST_MONTH_LOCK);
      } else if (err instanceof Error && err.message === "amount exceeds outstanding") {
        setError(AP_VALIDATION.payTooMuch);
      } else if (err instanceof Error && err.message === "category required for payment") {
        setError(AP_VALIDATION.categoryRequiredForPayment);
      } else {
        setError(ENGINE_ERROR.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div
        className="flex w-full max-w-sm flex-col gap-3 rounded-t-lg bg-panel p-4 shadow-[0_8px_24px_rgb(38_34_30_/_0.14)] sm:rounded-lg"
        role="dialog"
        aria-modal="true"
        aria-label={AP_PAY.heading}
      >
        <h2 className="text-sm font-semibold text-ink">{AP_PAY.heading}</h2>

        <div>
          <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="ap-pay-date">
            {AP_PAY.date}
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={dateInputRef}
              id="ap-pay-date"
              key={date}
              type="date"
              defaultValue={date}
              min={`${currentMonthBangkok()}-01`}
              max={todayBangkok()}
              className="rounded-md border border-line-strong px-2 py-1.5 text-sm tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
            <span className="text-sm font-semibold text-ink">{isoToThaiLong(date)}</span>
          </div>
        </div>

        <div>
          <div className="mb-1.5 flex items-center justify-between">
            <label className="block text-xs font-semibold text-ink-muted" htmlFor="ap-pay-amount">
              {AP_PAY.amount}
            </label>
            <button type="button" onClick={payFull} className="text-xs font-medium text-brand-500 hover:underline">
              {AP_PAY.payFull}
            </button>
          </div>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">฿</span>
            <input
              ref={amountInputRef}
              id="ap-pay-amount"
              type="text"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              className="h-12 w-full rounded-md border border-line-strong bg-panel pl-7 pr-3 text-right text-xl font-semibold tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
          </div>
          <p className="mt-1 text-xs text-ink-muted">
            {AP_FIELDS.outstanding}: ฿{formatSatang(row.outstandingSatang)}
          </p>
        </div>

        {needsCategoryPicker && (
          <div>
            <label className="mb-1.5 block text-xs font-semibold text-ink-muted">{AP_FIELDS.category}</label>
            <CategoryPicker value={pickedCategoryCode} onChange={setPickedCategoryCode} recentCodes={recentCodes} />
          </div>
        )}

        <div>
          <label className="mb-1.5 block text-xs font-semibold text-ink-muted">{FIELD_LABELS.paymentMethod}</label>
          <div role="radiogroup" aria-label={FIELD_LABELS.paymentMethod} className="flex gap-0.5 rounded-md bg-tint p-1">
            {(["cash", "bank"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={paymentMethod === m}
                onClick={() => {
                  setPaymentMethod(m);
                  savePaymentMethod(m);
                }}
                className={
                  "h-11 flex-1 rounded-md text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-500/40 " +
                  (paymentMethod === m ? "bg-panel text-brand-700 shadow-sm" : "text-ink-muted hover:text-ink")
                }
              >
                {PAYMENT_METHOD_LABELS[m]}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="text-xs text-bad">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-line-strong px-3 py-2 text-xs font-medium text-ink hover:bg-tint"
          >
            {AP_PAY.cancel}
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={submitting}
            className="rounded-md bg-brand-500 px-4 py-2 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
          >
            {AP_PAY.submit}
          </button>
        </div>
      </div>
    </div>
  );
}
