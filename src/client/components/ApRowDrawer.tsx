import { useEffect, useRef, useState } from "react";
import { createApRow, deleteApPayment, deleteApRow, EngineUnreachableError, SessionExpiredError, updateApRow } from "../api.ts";
import { categoryByCode, type ExpenseCategoryCode } from "../../shared/categories.ts";
import { isoToBuddhist, isoToThaiLong } from "../../shared/date.ts";
import { formatSatang, parseAmountToSatang } from "../../shared/money.ts";
import {
  computeGross,
  computeOutstanding,
  type ApCreditorHint,
  type ApPayment,
  type ApRow,
  type ApRowInput,
} from "../../shared/apTypes.ts";
import { CategoryPicker } from "./CategoryPicker.tsx";
import { ApPaymentForm } from "./ApPaymentForm.tsx";
import {
  AP,
  AP_ENTITIES,
  AP_FIELDS,
  AP_PAY,
  AP_VALIDATION,
  EDIT_DRAWER,
  ENGINE_ERROR,
  SAVE,
  VALIDATION,
} from "../labels.ts";
import { loadRecentCategories } from "../storage.ts";

interface Props {
  /** null = add mode, starts empty (spec §4: "Add and edit are the same
   * component; add starts empty"). */
  row: ApRow | null;
  creditors: ApCreditorHint[];
  onClose: () => void;
  onSaved: () => void;
  onDeleted: () => void;
  /** A payment was posted or undone from WITHIN this drawer — the parent
   * refetches the list in the background (so the header summary and other
   * rows' status stay correct) while this drawer stays open, since `row`
   * flows back in as an updated prop once the parent's data reloads. */
  onPaymentChanged: () => void;
}

interface FieldErrors {
  creditor?: string;
  item?: string;
  amount?: string;
  category?: string;
  outstanding?: string;
}

function paymentKindLabel(p: ApPayment): string {
  if (p.kind === "deposit") return AP_FIELDS.deposit;
  if (p.kind === "installment") return AP_FIELDS.installment(p.installmentNumber ?? 0);
  return AP_PAY.kindFull;
}

/**
 * One drawer for both add and edit (spec §4) — field order mirrors the
 * paper sheet's column order exactly. Right drawer at lg, bottom sheet
 * below; same shell conventions as EditDrawer.tsx (Escape closes,
 * role=dialog, bg-black/40 backdrop).
 */
export function ApRowDrawer({ row, creditors, onClose, onSaved, onDeleted, onPaymentChanged }: Props) {
  const recentCodes = useState(() => loadRecentCategories())[0];

  const [creditor, setCreditor] = useState(row?.creditor ?? "");
  const [item, setItem] = useState(row?.item ?? "");
  const [amountText, setAmountText] = useState(row ? (row.amountSatang / 100).toFixed(2) : "");
  const [vatText, setVatText] = useState(row?.vatSatang != null ? (row.vatSatang / 100).toFixed(2) : "");
  const [whtText, setWhtText] = useState(row?.whtSatang != null ? (row.whtSatang / 100).toFixed(2) : "");
  const [discountText, setDiscountText] = useState(row && row.discountSatang > 0 ? (row.discountSatang / 100).toFixed(2) : "");
  const [dueDate, setDueDate] = useState(row?.dueDate ?? "");
  const [entity, setEntity] = useState(row?.entity ?? "");
  const [categoryCode, setCategoryCode] = useState<ExpenseCategoryCode | null>(row?.categoryCode ?? null);
  const [note, setNote] = useState(row?.note ?? "");

  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [undoingId, setUndoingId] = useState<string | null>(null);
  const [undoError, setUndoError] = useState<string | null>(null);

  const [showPaymentForm, setShowPaymentForm] = useState(false);
  const [postedNotice, setPostedNotice] = useState<string | null>(null);

  const creditorInputRef = useRef<HTMLInputElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);
  const dueDateInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = dueDateInputRef.current;
    if (!el) return;
    const commit = () => {
      if (el.value !== dueDate) setDueDate(el.value);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, [dueDate]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  function handleCreditorChange(value: string) {
    setCreditor(value);
    // Prefill หมวดค่าใช้จ่าย/ในนาม from the creditor's most recent row (spec
    // §4 item 1) — only in ADD mode, so editing an existing row's creditor
    // name never silently overwrites a category the clerk already chose.
    if (row === null) {
      const hint = creditors.find((c) => c.creditor === value);
      if (hint) {
        setCategoryCode(hint.categoryCode);
        setEntity(hint.entity);
      }
    }
  }

  function applyVat() {
    const amountSatang = parseAmountToSatang(amountText);
    if (amountSatang === null) return;
    setVatText((Math.round(amountSatang * 0.07) / 100).toFixed(2));
  }

  const amountSatangLive = parseAmountToSatang(amountText) ?? 0;
  const vatSatangLive = vatText.trim() === "" ? null : (parseAmountToSatang(vatText) ?? 0);
  const whtSatangLive = whtText.trim() === "" ? null : (parseAmountToSatang(whtText) ?? 0);
  const discountSatangLive = discountText.trim() === "" ? 0 : (parseAmountToSatang(discountText) ?? 0);
  const grossLive = computeGross(amountSatangLive, vatSatangLive, whtSatangLive);
  const outstandingLive = computeOutstanding(grossLive, row?.payments ?? [], discountSatangLive);

  function validate(): FieldErrors | null {
    const next: FieldErrors = {};
    if (creditor.trim() === "") next.creditor = AP_VALIDATION.creditorRequired;
    if (item.trim() === "") next.item = AP_VALIDATION.itemRequired;

    const parsedAmount = parseAmountToSatang(amountText);
    if (amountText.trim() === "") next.amount = VALIDATION.amountRequired;
    else if (parsedAmount === null || parsedAmount <= 0) next.amount = VALIDATION.amountInvalid;

    if (!categoryCode) next.category = VALIDATION.categoryRequired;

    if (Object.keys(next).length === 0 && outstandingLive < 0) {
      next.outstanding = AP_VALIDATION.negativeOutstanding;
    }
    return Object.keys(next).length > 0 ? next : null;
  }

  async function handleSave() {
    const validationErrors = validate();
    if (validationErrors) {
      setErrors(validationErrors);
      if (validationErrors.creditor) creditorInputRef.current?.focus();
      else if (validationErrors.amount) amountInputRef.current?.focus();
      return;
    }
    setErrors({});
    setSaveError(null);
    setSaving(true);

    const input: ApRowInput = {
      creditor: creditor.trim(),
      item: item.trim(),
      amountSatang: amountSatangLive,
      vatSatang: vatSatangLive,
      whtSatang: whtSatangLive,
      discountSatang: discountSatangLive,
      dueDate: dueDate.trim() === "" ? null : dueDate,
      entity: entity.trim(),
      categoryCode: categoryCode!,
      note,
    };

    try {
      if (row) await updateApRow(row.id, input);
      else await createApRow(input);
      onSaved();
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      if (err instanceof Error && err.message === "negative outstanding") {
        setErrors({ outstanding: AP_VALIDATION.negativeOutstanding });
      } else if (err instanceof EngineUnreachableError) {
        setSaveError(ENGINE_ERROR.message);
      } else {
        setSaveError(ENGINE_ERROR.message);
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!row) return;
    if (!window.confirm(EDIT_DRAWER.confirmDelete)) return;
    setDeleting(true);
    try {
      await deleteApRow(row.id);
      onDeleted();
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      if (err instanceof Error && err.message === "has_payments") window.alert(AP_VALIDATION.hasPayments);
      else window.alert(ENGINE_ERROR.message);
    } finally {
      setDeleting(false);
    }
  }

  async function handleUndo(paymentId: string) {
    if (!row) return;
    setUndoingId(paymentId);
    setUndoError(null);
    try {
      await deleteApPayment(row.id, paymentId);
      onPaymentChanged();
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      if (err instanceof Error && err.message === "ledger_month_locked") setUndoError(AP_VALIDATION.undoLocked);
      else setUndoError(ENGINE_ERROR.message);
    } finally {
      setUndoingId(null);
    }
  }

  const heading = row ? row.creditor : AP.add;
  const canDelete = row !== null && row.payments.length === 0;

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-end bg-black/40 lg:items-stretch">
      <div
        className="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-lg bg-panel shadow-[0_8px_24px_rgb(38_34_30_/_0.14)] lg:h-full lg:max-h-none lg:w-[420px] lg:rounded-none"
        role="dialog"
        aria-modal="true"
        aria-label={heading}
      >
        <div className="border-b border-line px-4 py-3">
          <h2 className="truncate text-sm font-semibold text-ink">{heading}</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="ap-creditor">
                {AP_FIELDS.creditor}
              </label>
              <input
                ref={creditorInputRef}
                id="ap-creditor"
                type="text"
                list="ap-creditor-list"
                value={creditor}
                onChange={(e) => handleCreditorChange(e.target.value)}
                maxLength={200}
                className="w-full rounded-md border border-line-strong bg-panel px-2.5 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              />
              <datalist id="ap-creditor-list">
                {creditors.map((c) => (
                  <option key={c.creditor} value={c.creditor} />
                ))}
              </datalist>
              {errors.creditor && <p className="mt-1 text-xs text-bad">{errors.creditor}</p>}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="ap-item">
                {AP_FIELDS.item}
              </label>
              <input
                id="ap-item"
                type="text"
                value={item}
                onChange={(e) => setItem(e.target.value)}
                maxLength={200}
                className="w-full rounded-md border border-line-strong bg-panel px-2.5 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              />
              {errors.item && <p className="mt-1 text-xs text-bad">{errors.item}</p>}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="ap-amount">
                {AP_FIELDS.amount}
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">฿</span>
                <input
                  ref={amountInputRef}
                  id="ap-amount"
                  type="text"
                  inputMode="decimal"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  className="h-12 w-full rounded-md border border-line-strong bg-panel pl-7 pr-3 text-right text-xl font-semibold tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                />
              </div>
              {errors.amount && <p className="mt-1 text-xs text-bad">{errors.amount}</p>}
            </div>

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <label className="block text-xs font-semibold text-ink-muted" htmlFor="ap-vat">
                  {AP_FIELDS.vat}
                </label>
                <button type="button" onClick={applyVat} className="text-xs font-medium text-brand-500 hover:underline">
                  {AP_PAY.vatAuto}
                </button>
              </div>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">฿</span>
                <input
                  id="ap-vat"
                  type="text"
                  inputMode="decimal"
                  value={vatText}
                  onChange={(e) => setVatText(e.target.value)}
                  className="h-10 w-full rounded-md border border-line-strong bg-panel pl-7 pr-3 text-right text-sm tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                />
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="ap-wht">
                {AP_FIELDS.wht}
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">฿</span>
                <input
                  id="ap-wht"
                  type="text"
                  inputMode="decimal"
                  value={whtText}
                  onChange={(e) => setWhtText(e.target.value)}
                  className="h-10 w-full rounded-md border border-line-strong bg-panel pl-7 pr-3 text-right text-sm tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                />
              </div>
            </div>

            <div>
              <span className="mb-1.5 block text-xs font-semibold text-ink-muted">{AP_FIELDS.gross}</span>
              <div className="rounded-md border border-line bg-tint px-3 py-2 text-right text-sm font-semibold tabular-nums text-ink">
                ฿{formatSatang(grossLive)}
              </div>
            </div>

            <div>
              <span className="mb-1.5 block text-xs font-semibold text-ink-muted">{AP_PAY.history}</span>
              {row === null || row.payments.length === 0 ? (
                <p className="rounded-md border border-line bg-tint px-3 py-2 text-sm text-ink-muted">
                  {AP_PAY.historyEmpty}
                </p>
              ) : (
                <div className="flex flex-col gap-1.5">
                  {row.payments.map((p) => (
                    <div
                      key={p.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line px-3 py-2 text-xs"
                    >
                      <span className="text-ink">
                        <span className="font-medium">{paymentKindLabel(p)}</span>
                        <span className="text-ink-muted"> · {isoToBuddhist(p.date)} · </span>
                        <span className="font-medium tabular-nums">฿{formatSatang(p.amountSatang)}</span>
                        <span className="text-ink-muted"> · {p.payerEmail.split("@")[0]}</span>
                      </span>
                      <button
                        type="button"
                        onClick={() => void handleUndo(p.id)}
                        disabled={undoingId === p.id}
                        className="shrink-0 text-xs font-medium text-bad hover:underline disabled:opacity-50"
                      >
                        {AP_PAY.undo}
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {undoError && <p className="mt-1 text-xs text-bad">{undoError}</p>}
              {postedNotice && <p className="mt-1 text-xs text-ok">{postedNotice}</p>}
              {row !== null && row.outstandingSatang > 0 && (
                <button
                  type="button"
                  onClick={() => setShowPaymentForm(true)}
                  className="mt-2 h-10 w-full rounded-md border border-line-strong bg-panel text-sm font-medium text-ink hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                >
                  {AP_PAY.heading}
                </button>
              )}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="ap-discount">
                {AP_FIELDS.discount}
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">฿</span>
                <input
                  id="ap-discount"
                  type="text"
                  inputMode="decimal"
                  value={discountText}
                  onChange={(e) => setDiscountText(e.target.value)}
                  className="h-10 w-full rounded-md border border-line-strong bg-panel pl-7 pr-3 text-right text-sm tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                />
              </div>
            </div>

            <div>
              <span className="mb-1.5 block text-xs font-semibold text-ink-muted">{AP_FIELDS.outstanding}</span>
              <div className="rounded-md border border-line-strong bg-tint px-3 py-2 text-right text-base font-bold tabular-nums text-ink">
                ฿{formatSatang(outstandingLive)}
              </div>
              {errors.outstanding && <p className="mt-1 text-xs text-bad">{errors.outstanding}</p>}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="ap-due-date">
                {AP_FIELDS.dueDate}
              </label>
              <div className="flex items-center gap-2">
                <input
                  ref={dueDateInputRef}
                  id="ap-due-date"
                  key={dueDate}
                  type="date"
                  defaultValue={dueDate}
                  className="rounded-md border border-line-strong px-2 py-1.5 text-sm tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
                />
                {dueDate && <span className="text-sm font-semibold text-ink">{isoToThaiLong(dueDate)}</span>}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="ap-entity">
                {AP_FIELDS.entity}
              </label>
              <input
                id="ap-entity"
                type="text"
                list="ap-entity-list"
                value={entity}
                onChange={(e) => setEntity(e.target.value)}
                maxLength={200}
                className="w-full rounded-md border border-line-strong bg-panel px-2.5 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              />
              <datalist id="ap-entity-list">
                {AP_ENTITIES.map((e) => (
                  <option key={e} value={e} />
                ))}
              </datalist>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted">{AP_FIELDS.category}</label>
              <CategoryPicker value={categoryCode} onChange={setCategoryCode} recentCodes={recentCodes} />
              {errors.category && <p className="mt-1 text-xs text-bad">{errors.category}</p>}
              <p className="mt-2 rounded-md bg-tint px-3 py-2 text-xs text-ink-muted">{AP_PAY.autoPostNotice}</p>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="ap-note">
                {AP_FIELDS.note}
              </label>
              <input
                id="ap-note"
                type="text"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                maxLength={200}
                placeholder="เช่น โทรตามยอด 25/3/69"
                className="w-full rounded-md border border-line-strong bg-panel px-2.5 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
              />
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
          {canDelete ? (
            <button
              type="button"
              onClick={handleDelete}
              disabled={deleting}
              className="rounded-md border border-bad/40 px-3 py-1.5 text-xs font-medium text-bad hover:bg-bad/10 disabled:opacity-50"
            >
              {EDIT_DRAWER.delete}
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {saveError && <span className="text-xs text-bad">{saveError}</span>}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-tint"
            >
              {EDIT_DRAWER.cancel}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={saving}
              className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? SAVE.saving : row ? EDIT_DRAWER.save : SAVE.idle}
            </button>
          </div>
        </div>
      </div>

      {showPaymentForm && row && (
        <ApPaymentForm
          row={row}
          onClose={() => setShowPaymentForm(false)}
          onPosted={(dateIso) => {
            setShowPaymentForm(false);
            setPostedNotice(AP_PAY.posted(categoryByCode(row.categoryCode).label, isoToBuddhist(dateIso)));
            onPaymentChanged();
            setTimeout(() => setPostedNotice(null), 4000);
          }}
        />
      )}
    </div>
  );
}
