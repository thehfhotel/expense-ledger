import { useEffect, useRef, useState } from "react";
import { deleteExpense, deleteExpensePhoto, updateExpense, uploadExpensePhoto } from "../api.ts";
import { EngineUnreachableError, SessionExpiredError } from "../api.ts";
import { isBillingMonthCategory, type ExpenseCategoryCode } from "../../shared/categories.ts";
import { currentMonthBangkok, isoToThaiLong, todayBangkok } from "../../shared/date.ts";
import { formatSatang, parseAmountToSatang } from "../../shared/money.ts";
import { AMOUNT_IN_TEXT_WARNING_TH, looksLikeAmountInText } from "../../shared/textAmount.ts";
import type { ExpensePhoto, ExpenseTransaction, PaymentMethod } from "../../shared/types.ts";
import {
  AMOUNT_ARIA_LABEL,
  AMOUNT_PLACEHOLDER,
  EDIT_DRAWER,
  ENGINE_ERROR,
  FIELD_LABELS,
  ITEM_PLACEHOLDER_BILLING_MONTH,
  ITEM_PLACEHOLDER_DEFAULT,
  PAST_MONTH_LOCK,
  PAYMENT_METHOD_LABELS,
  PHOTO,
  SAVE,
  VALIDATION,
} from "../labels.ts";
import { CategoryPicker } from "./CategoryPicker.tsx";
import { PhotoLightbox } from "./PhotoLightbox.tsx";

interface Props {
  item: ExpenseTransaction;
  recentCodes: ExpenseCategoryCode[];
  onClose: () => void;
  /** No payload — PATCH only returns { id } (frontend spec §9), so the
   * parent re-fetches its list rather than trusting a reconstructed item. */
  onSaved: () => void;
  onDeleted: (id: string) => void;
}

interface FieldErrors {
  amount?: string;
  category?: string;
  date?: string;
}

/**
 * Right drawer at lg (bottom sheet below), pre-filled with the entry's
 * fields (frontend spec §4). "Current month only": if the entry's date
 * falls outside currentMonthBangkok(), every control is disabled, delete is
 * hidden, and a warning strip explains why — the server enforces the same
 * rule with 409, this is a hint, not the gate.
 */
export function EditDrawer({ item, recentCodes, onClose, onSaved, onDeleted }: Props) {
  const locked = item.date.slice(0, 7) !== currentMonthBangkok();

  const [date, setDate] = useState(item.date);
  const [amountText, setAmountText] = useState((item.amountSatang / 100).toFixed(2));
  const [categoryCode, setCategoryCode] = useState(item.categoryCode);
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(item.paymentMethod);
  const [comment, setComment] = useState(item.comment);
  const [photos, setPhotos] = useState<ExpensePhoto[]>(item.photos);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);

  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [engineError, setEngineError] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const dateInputRef = useRef<HTMLInputElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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

  function validate(): FieldErrors | null {
    const next: FieldErrors = {};
    const parsedAmount = parseAmountToSatang(amountText);
    if (amountText.trim() === "") next.amount = VALIDATION.amountRequired;
    else if (parsedAmount === null || parsedAmount <= 0) next.amount = VALIDATION.amountInvalid;
    if (!categoryCode) next.category = VALIDATION.categoryRequired;
    if (date > todayBangkok()) next.date = VALIDATION.dateNotFuture;
    return Object.keys(next).length > 0 ? next : null;
  }

  async function handleSave() {
    if (locked) return;
    const validationErrors = validate();
    if (validationErrors) {
      setErrors(validationErrors);
      if (validationErrors.amount) amountInputRef.current?.focus();
      return;
    }
    setErrors({});
    setEngineError(false);
    setSaving(true);
    try {
      await updateExpense(item.id, {
        date,
        amountSatang: parseAmountToSatang(amountText)!,
        categoryCode: categoryCode!,
        paymentMethod,
        comment,
      });
      onSaved();
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      if (err instanceof EngineUnreachableError) setEngineError(true);
      else setEngineError(true);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (locked) return;
    if (!window.confirm(EDIT_DRAWER.confirmDelete)) return;
    setDeleting(true);
    try {
      await deleteExpense(item.id);
      onDeleted(item.id);
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) {
        window.alert(err instanceof Error ? err.message : "ลบรายการไม่สำเร็จ ลองใหม่อีกครั้ง");
      }
    } finally {
      setDeleting(false);
    }
  }

  async function handleAddPhoto(files: FileList | null) {
    if (!files || files.length === 0 || locked) return;
    setPhotoBusy(true);
    setPhotoError(null);
    for (const file of Array.from(files)) {
      try {
        const uploaded = await uploadExpensePhoto(item.id, file, file.name);
        setPhotos((prev) => [...prev, uploaded]);
      } catch (err) {
        if (err instanceof SessionExpiredError) break;
        setPhotoError(ENGINE_ERROR.message);
      }
    }
    setPhotoBusy(false);
  }

  async function handleRemovePhoto(photoId: string) {
    if (locked) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      await deleteExpensePhoto(item.id, photoId);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setPhotoError(ENGINE_ERROR.message);
    } finally {
      setPhotoBusy(false);
    }
  }

  const itemPlaceholder =
    categoryCode && isBillingMonthCategory(categoryCode) ? ITEM_PLACEHOLDER_BILLING_MONTH : ITEM_PLACEHOLDER_DEFAULT;

  return (
    <div className="fixed inset-0 z-30 flex items-end justify-end bg-black/40 lg:items-stretch">
      <div
        className="flex max-h-[85vh] w-full flex-col overflow-hidden rounded-t-lg bg-panel shadow-[0_8px_24px_rgb(38_34_30_/_0.14)] lg:h-full lg:max-h-none lg:w-[420px] lg:rounded-none"
        role="dialog"
        aria-modal="true"
        aria-label={EDIT_DRAWER.heading}
      >
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{EDIT_DRAWER.heading}</h2>
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {locked && (
            <p className="mb-3 rounded-md border border-warn/40 bg-gold-50 px-3 py-2 text-sm text-warn">
              {PAST_MONTH_LOCK}
            </p>
          )}

          <div className="flex flex-col gap-3">
            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="drawer-date">
                {FIELD_LABELS.date}
              </label>
              <div className="flex items-center gap-2">
                <input
                  ref={dateInputRef}
                  id="drawer-date"
                  key={date}
                  type="date"
                  defaultValue={date}
                  min={`${currentMonthBangkok()}-01`}
                  max={todayBangkok()}
                  disabled={locked}
                  className="rounded-md border border-line-strong px-2 py-1.5 text-sm tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint disabled:text-ink-muted"
                />
                <span className="text-sm font-semibold text-ink">{isoToThaiLong(date)}</span>
              </div>
              {errors.date && <p className="mt-1 text-xs text-bad">{errors.date}</p>}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="drawer-amount">
                {FIELD_LABELS.amount}
              </label>
              <div className="relative">
                <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">฿</span>
                <input
                  ref={amountInputRef}
                  id="drawer-amount"
                  type="text"
                  inputMode="decimal"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  placeholder={AMOUNT_PLACEHOLDER}
                  aria-label={AMOUNT_ARIA_LABEL}
                  disabled={locked}
                  className="h-12 w-full rounded-md border border-line-strong bg-panel pl-7 pr-3 text-right text-xl font-semibold tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint disabled:text-ink-muted"
                />
              </div>
              {errors.amount && <p className="mt-1 text-xs text-bad">{errors.amount}</p>}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted">{FIELD_LABELS.category}</label>
              {locked ? (
                <p className="rounded-md border border-line bg-tint px-3 py-2 text-sm text-ink-muted">
                  {categoryCode}
                </p>
              ) : (
                <CategoryPicker value={categoryCode} onChange={setCategoryCode} recentCodes={recentCodes} />
              )}
              {errors.category && <p className="mt-1 text-xs text-bad">{errors.category}</p>}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted">{FIELD_LABELS.paymentMethod}</label>
              <div role="radiogroup" aria-label={FIELD_LABELS.paymentMethod} className="flex gap-0.5 rounded-md bg-tint p-1">
                {(["cash", "bank"] as const).map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={paymentMethod === m}
                    disabled={locked}
                    onClick={() => setPaymentMethod(m)}
                    className={
                      "h-12 flex-1 rounded-md text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50 " +
                      (paymentMethod === m ? "bg-panel text-brand-700 shadow-sm" : "text-ink-muted hover:text-ink")
                    }
                  >
                    {PAYMENT_METHOD_LABELS[m]}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="drawer-comment">
                {FIELD_LABELS.item}
              </label>
              <input
                id="drawer-comment"
                type="text"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                maxLength={200}
                placeholder={itemPlaceholder}
                disabled={locked}
                className="w-full rounded-md border border-line-strong bg-panel px-2.5 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:bg-tint disabled:text-ink-muted"
              />
              {looksLikeAmountInText(comment) && <p className="mt-1 text-xs text-warn">{AMOUNT_IN_TEXT_WARNING_TH}</p>}
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted">{FIELD_LABELS.photo}</label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
                onChange={(e) => {
                  void handleAddPhoto(e.target.files);
                  e.target.value = "";
                }}
              />
              {photos.length > 0 && (
                <div className="mb-2 flex flex-wrap gap-2">
                  {photos.map((photo) => (
                    <div key={photo.id} className="flex flex-col items-center gap-1">
                      <button type="button" onClick={() => setLightboxUrl(photo.url)}>
                        <img src={photo.url} alt="" className="h-16 w-16 rounded-md border border-line object-cover" />
                      </button>
                      {!locked && (
                        <button
                          type="button"
                          onClick={() => handleRemovePhoto(photo.id)}
                          disabled={photoBusy}
                          className="text-xs text-bad hover:underline disabled:opacity-50"
                        >
                          {PHOTO.remove}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {!locked && (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={photoBusy}
                  className="h-12 rounded-md border border-line-strong bg-panel px-4 text-sm font-medium text-ink hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50"
                >
                  {PHOTO.choose}
                </button>
              )}
              {photoError && <p className="mt-1 text-xs text-bad">{photoError}</p>}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-3">
          {!locked ? (
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
            {engineError && (
              <span className="text-xs text-bad">{ENGINE_ERROR.message}</span>
            )}
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line-strong px-3 py-1.5 text-xs font-medium text-ink hover:bg-tint"
            >
              {EDIT_DRAWER.cancel}
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving || locked}
              className="rounded-md bg-brand-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-brand-600 disabled:opacity-50"
            >
              {saving ? SAVE.saving : EDIT_DRAWER.save}
            </button>
          </div>
        </div>
      </div>

      {lightboxUrl && <PhotoLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
}
