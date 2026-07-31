import { useEffect, useMemo, useRef, useState } from "react";
import { EngineUnreachableError, SessionExpiredError, createExpense, getMonthExpenses, uploadExpensePhoto } from "../api.ts";
import { EditDrawer } from "../components/EditDrawer.tsx";
import { categoryByCode, isBillingMonthCategory, type ExpenseCategoryCode } from "../../shared/categories.ts";
import { CategoryPicker } from "../components/CategoryPicker.tsx";
import { currentMonthBangkok, isoToThaiLong, todayBangkok } from "../../shared/date.ts";
import { formatSatang, parseAmountToSatang } from "../../shared/money.ts";
import { AMOUNT_IN_TEXT_WARNING_TH, looksLikeAmountInText } from "../../shared/textAmount.ts";
import type { ExpenseInput, ExpenseTransaction, PaymentMethod } from "../../shared/types.ts";
import {
  AMOUNT_ARIA_LABEL,
  AMOUNT_PLACEHOLDER,
  DAY_STRIP,
  ENGINE_ERROR,
  FIELD_LABELS,
  ITEM_PLACEHOLDER_BILLING_MONTH,
  ITEM_PLACEHOLDER_DEFAULT,
  LOADING,
  PAYMENT_METHOD_LABELS,
  PHOTO,
  SAVE,
  VALIDATION,
} from "../labels.ts";
import {
  clearDraft,
  loadDraft,
  loadPaymentMethod,
  loadRecentCategories,
  pushRecentCategory,
  saveDraft,
  savePaymentMethod,
  type DraftState,
} from "../storage.ts";

interface Props {
  /** Deep link from the month checklist (/entry?cat=<code>) — the ONE case
   * where a category is allowed to arrive pre-selected (frontend spec
   * §2.3): the clerk explicitly chose that line. */
  initialCategoryCode?: ExpenseCategoryCode;
}

interface FieldErrors {
  amount?: string;
  category?: string;
  date?: string;
}

const HIGHLIGHT_MS = 300;

/** Screen 1 — บันทึกรายจ่าย (frontend spec §2). Batch entry of a stack of
 * bills: keyboard-first, six fields on one screen, no wizard. */
export function EntryPage({ initialCategoryCode }: Props) {
  const draft = useMemo(() => loadDraft(), []);

  const [date, setDate] = useState(draft?.date ?? todayBangkok());
  const [amountText, setAmountText] = useState(draft?.amountText ?? "");
  const [categoryCode, setCategoryCode] = useState<ExpenseCategoryCode | null>(
    initialCategoryCode ?? draft?.categoryCode ?? null,
  );
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(draft?.paymentMethod ?? loadPaymentMethod());
  const [comment, setComment] = useState(draft?.comment ?? "");
  const [stagedPhotos, setStagedPhotos] = useState<File[]>([]);

  const [recentCodes, setRecentCodes] = useState<ExpenseCategoryCode[]>(() => loadRecentCategories());
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [engineError, setEngineError] = useState(false);

  const [dayEntries, setDayEntries] = useState<ExpenseTransaction[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const [photoFailures, setPhotoFailures] = useState<Record<string, File[]>>({});
  const [editingItem, setEditingItem] = useState<ExpenseTransaction | null>(null);

  const dateInputRef = useRef<HTMLInputElement>(null);
  const amountInputRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Mirror every change to localStorage so an engine-unreachable or
  // session-expired reload never loses in-progress work (frontend spec §6
  // "Draft preservation").
  useEffect(() => {
    const state: DraftState = { date, amountText, categoryCode, paymentMethod, comment };
    saveDraft(state);
  }, [date, amountText, categoryCode, paymentMethod, comment]);

  // วันที่: uncontrolled + commit-on-native-change (DateBar.tsx's fix —
  // never React's onChange, or a two-digit day loses its second keystroke).
  useEffect(() => {
    const el = dateInputRef.current;
    if (!el) return;
    const commit = () => {
      if (el.value && el.value !== date) setDate(el.value);
    };
    el.addEventListener("change", commit);
    return () => el.removeEventListener("change", commit);
  }, [date]);

  // Ctrl+Enter saves from anywhere in the form.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.ctrlKey && e.key === "Enter") {
        e.preventDefault();
        void handleSave();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  });

  // Desktop paste (Ctrl+V) of a scanned invoice image, anywhere on the page
  // while this screen is open (frontend spec §2.6).
  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items;
      if (!items) return;
      const files: File[] = [];
      for (const item of items) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) files.push(file);
        }
      }
      if (files.length > 0) setStagedPhotos((prev) => [...prev, ...files]);
    }
    document.addEventListener("paste", onPaste);
    return () => document.removeEventListener("paste", onPaste);
  }, []);

  async function loadDayStrip(forDate: string) {
    try {
      const month = forDate.slice(0, 7);
      const res = await getMonthExpenses(month);
      setDayEntries(res.items.filter((item) => item.date === forDate));
      setLoadError(null);
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      setDayEntries([]);
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    setDayEntries(null);
    void loadDayStrip(date);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  function validate(): FieldErrors | null {
    const next: FieldErrors = {};
    const parsedAmount = parseAmountToSatang(amountText);
    if (amountText.trim() === "") next.amount = VALIDATION.amountRequired;
    else if (parsedAmount === null || parsedAmount <= 0) next.amount = VALIDATION.amountInvalid;
    if (!categoryCode) next.category = VALIDATION.categoryRequired;
    if (date > todayBangkok()) next.date = VALIDATION.dateNotFuture;
    return Object.keys(next).length > 0 ? next : null;
  }

  function buildInput(): ExpenseInput {
    return {
      date,
      amountSatang: parseAmountToSatang(amountText)!,
      categoryCode: categoryCode!,
      paymentMethod,
      comment,
    };
  }

  async function handleSave() {
    const validationErrors = validate();
    if (validationErrors) {
      setErrors(validationErrors);
      if (validationErrors.amount) amountInputRef.current?.focus();
      else if (validationErrors.date) dateInputRef.current?.focus();
      return;
    }
    setErrors({});
    setEngineError(false);
    setSaving(true);

    const input = buildInput();
    try {
      const { id } = await createExpense(input);

      // Photo attach-after-save (frontend spec §2.6): the entry is durable
      // the moment createExpense resolves; a photo failure never undoes it.
      const failures: File[] = [];
      for (const file of stagedPhotos) {
        try {
          await uploadExpensePhoto(id, file, file.name);
        } catch (err) {
          if (err instanceof SessionExpiredError) break;
          failures.push(file);
        }
      }
      if (failures.length > 0) setPhotoFailures((prev) => ({ ...prev, [id]: failures }));

      clearDraft();
      setRecentCodes(pushRecentCategory(input.categoryCode));
      savePaymentMethod(paymentMethod);

      // Reset per §2.7: keep วันที่ and จ่ายด้วย, clear everything else.
      setAmountText("");
      setCategoryCode(null);
      setComment("");
      setStagedPhotos([]);
      amountInputRef.current?.focus();

      setHighlightId(id);
      setTimeout(() => setHighlightId((current) => (current === id ? null : current)), HIGHLIGHT_MS);
      await loadDayStrip(date);
    } catch (err) {
      if (err instanceof SessionExpiredError) {
        // handled globally — form stays intact, nothing else to do here.
      } else if (err instanceof EngineUnreachableError) {
        setEngineError(true);
      } else {
        setEngineError(true);
      }
    } finally {
      setSaving(false);
    }
  }

  async function retryPhoto(id: string) {
    const files = photoFailures[id];
    if (!files || files.length === 0) return;
    const stillFailing: File[] = [];
    for (const file of files) {
      try {
        await uploadExpensePhoto(id, file, file.name);
      } catch (err) {
        if (err instanceof SessionExpiredError) return;
        stillFailing.push(file);
      }
    }
    setPhotoFailures((prev) => {
      const next = { ...prev };
      if (stillFailing.length > 0) next[id] = stillFailing;
      else delete next[id];
      return next;
    });
    await loadDayStrip(date);
  }

  function addFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    if (list.length > 0) setStagedPhotos((prev) => [...prev, ...list]);
  }

  const itemPlaceholder =
    categoryCode && isBillingMonthCategory(categoryCode) ? ITEM_PLACEHOLDER_BILLING_MONTH : ITEM_PLACEHOLDER_DEFAULT;

  return (
    <div className="flex flex-col gap-4">
      <div
        className="flex flex-col gap-4 lg:grid"
        style={{
          gridTemplateColumns: "380px 1fr",
          gridTemplateAreas: '"date cat" "amount cat" "pay cat" "item cat" "photo cat" "save cat"',
        }}
      >
        {/* วันที่ */}
        <div style={{ gridArea: "date" }} className="rounded-lg border border-line bg-panel p-4">
          <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="entry-date">
            {FIELD_LABELS.date}
          </label>
          <div className="flex items-center gap-2">
            <input
              ref={dateInputRef}
              id="entry-date"
              key={date}
              type="date"
              defaultValue={date}
              max={todayBangkok()}
              className="rounded-md border border-line-strong px-2 py-1.5 text-sm tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
            <span className="text-sm font-semibold text-ink">{isoToThaiLong(date)}</span>
          </div>
          {errors.date && <p className="mt-1 text-xs text-bad">{errors.date}</p>}
        </div>

        {/* จำนวนเงิน */}
        <div style={{ gridArea: "amount" }} className="rounded-lg border border-line bg-panel p-4">
          <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="entry-amount">
            {FIELD_LABELS.amount}
          </label>
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted">฿</span>
            <input
              ref={amountInputRef}
              id="entry-amount"
              type="text"
              inputMode="decimal"
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              placeholder={AMOUNT_PLACEHOLDER}
              aria-label={AMOUNT_ARIA_LABEL}
              autoFocus
              className="h-12 w-full rounded-md border border-line-strong bg-panel pl-7 pr-3 text-right text-xl font-semibold tabular-nums text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
            />
          </div>
          {errors.amount && <p className="mt-1 text-xs text-bad">{errors.amount}</p>}
        </div>

        {/* หมวดค่าใช้จ่าย — spans the full right column across every row above */}
        <div style={{ gridArea: "cat" }}>
          <label className="mb-1.5 block text-xs font-semibold text-ink-muted">{FIELD_LABELS.category}</label>
          <CategoryPicker value={categoryCode} onChange={setCategoryCode} recentCodes={recentCodes} />
          {errors.category && <p className="mt-1 text-xs text-bad">{errors.category}</p>}
        </div>

        {/* จ่ายด้วย */}
        <div style={{ gridArea: "pay" }} className="rounded-lg border border-line bg-panel p-4">
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
                  "h-12 flex-1 rounded-md text-sm font-semibold focus:outline-none focus:ring-2 focus:ring-brand-500/40 " +
                  (paymentMethod === m ? "bg-panel text-brand-700 shadow-sm" : "text-ink-muted hover:text-ink")
                }
              >
                {PAYMENT_METHOD_LABELS[m]}
              </button>
            ))}
          </div>
        </div>

        {/* รายการ / หมายเหตุ */}
        <div style={{ gridArea: "item" }} className="rounded-lg border border-line bg-panel p-4">
          <label className="mb-1.5 block text-xs font-semibold text-ink-muted" htmlFor="entry-comment">
            {FIELD_LABELS.item}
          </label>
          <input
            id="entry-comment"
            type="text"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            maxLength={200}
            placeholder={itemPlaceholder}
            className="w-full rounded-md border border-line-strong bg-panel px-2.5 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          />
          {looksLikeAmountInText(comment) && <p className="mt-1 text-xs text-warn">{AMOUNT_IN_TEXT_WARNING_TH}</p>}
        </div>

        {/* รูปบิล */}
        <div
          style={{ gridArea: "photo" }}
          className="rounded-lg border border-line bg-panel p-4"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            addFiles(Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/")));
          }}
        >
          <label className="mb-1.5 block text-xs font-semibold text-ink-muted">{FIELD_LABELS.photo}</label>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            capture="environment"
            multiple
            className="hidden"
            onChange={(e) => {
              addFiles(e.target.files);
              e.target.value = "";
            }}
          />
          {stagedPhotos.length > 0 && (
            <div className="mb-2 flex flex-wrap gap-2">
              {stagedPhotos.map((file, index) => (
                <div key={`${file.name}-${index}`} className="flex flex-col items-center gap-1">
                  <img
                    src={URL.createObjectURL(file)}
                    alt=""
                    className="h-16 w-16 rounded-md border border-line object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setStagedPhotos((prev) => prev.filter((_, i) => i !== index))}
                    className="text-xs text-bad hover:underline"
                  >
                    {PHOTO.remove}
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="h-12 rounded-md border border-line-strong bg-panel px-4 text-sm font-medium text-ink hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40"
          >
            {PHOTO.choose}
          </button>
        </div>

        {/* บันทึก */}
        <div
          style={{ gridArea: "save" }}
          className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-panel px-4 py-3 lg:static lg:z-auto lg:mx-0 lg:rounded-lg lg:border lg:border-line lg:p-4"
        >
          {engineError && (
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs text-bad">{ENGINE_ERROR.message}</p>
              <button
                type="button"
                onClick={() => void handleSave()}
                className="rounded-md border border-line-strong px-2.5 py-1 text-xs font-medium text-ink hover:bg-tint"
              >
                {ENGINE_ERROR.retry}
              </button>
            </div>
          )}
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving}
            className="h-13 w-full rounded-md bg-brand-500 text-base font-semibold text-white hover:bg-brand-600 focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50"
          >
            {saving ? SAVE.saving : SAVE.idle}
          </button>
        </div>
      </div>

      {/* Day strip — full width, below both columns */}
      <section className="rounded-lg border border-line bg-panel">
        <h2 className="border-b border-line px-4 py-2.5 text-sm font-semibold text-ink">
          {DAY_STRIP.heading(isoToThaiLong(date))}
        </h2>
        {loadError ? (
          <div className="p-4 text-sm text-bad">{loadError}</div>
        ) : dayEntries === null ? (
          <div className="p-6 text-sm text-ink-muted">{LOADING}</div>
        ) : dayEntries.length === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-muted">{DAY_STRIP.empty}</p>
        ) : (
          <div className="divide-y divide-line">
            {dayEntries.map((item) => (
              <div
                key={item.id}
                className={
                  "flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 text-sm transition-colors duration-300 " +
                  (highlightId === item.id ? "bg-gold-100" : "")
                }
              >
                <button
                  type="button"
                  onClick={() => setEditingItem(item)}
                  className="min-w-0 flex-1 truncate text-left text-ink hover:underline focus:outline-none"
                >
                  {categoryByCode(item.categoryCode).label}
                  <span className="text-ink-muted"> · {item.comment || "-"} · {PAYMENT_METHOD_LABELS[item.paymentMethod]}</span>
                </button>
                <span className="shrink-0 tabular-nums font-medium text-ink">฿{formatSatang(item.amountSatang)}</span>
                {photoFailures[item.id]?.length ? (
                  <span className="flex shrink-0 items-center gap-1.5 text-xs text-warn">
                    {PHOTO.notUploaded}
                    <button type="button" onClick={() => void retryPhoto(item.id)} className="underline">
                      {PHOTO.retry}
                    </button>
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      {editingItem && (
        <EditDrawer
          item={editingItem}
          recentCodes={recentCodes}
          onClose={() => setEditingItem(null)}
          onSaved={() => {
            setEditingItem(null);
            void loadDayStrip(date);
          }}
          onDeleted={() => {
            setEditingItem(null);
            void loadDayStrip(date);
          }}
        />
      )}
    </div>
  );
}
