import { useEffect, useMemo, useRef, useState } from "react";
import {
  createApRow,
  deleteApPayment,
  deleteApPhoto,
  deleteApRow,
  EngineUnreachableError,
  SessionExpiredError,
  updateApRow,
  uploadApPhoto,
} from "../api.ts";
import { categoryByCode, type ExpenseCategoryCode } from "../../shared/categories.ts";
import { isoToBuddhist, isoToThaiLong } from "../../shared/date.ts";
import { formatSatang, parseAmountToSatang } from "../../shared/money.ts";
import {
  apPhotoExtForFilename,
  computeGross,
  computeOutstanding,
  resolveCreditorHintCategoryCode,
  type ApCreditorHint,
  type ApPayment,
  type ApRow,
  type ApRowInput,
} from "../../shared/apTypes.ts";
import type { ExpensePhoto } from "../../shared/types.ts";
import { CategoryPicker } from "./CategoryPicker.tsx";
import { ApPaymentForm } from "./ApPaymentForm.tsx";
import { PhotoLightbox } from "./PhotoLightbox.tsx";
import {
  AP,
  AP_ENTITIES,
  AP_FIELDS,
  AP_PAY,
  AP_VALIDATION,
  EDIT_DRAWER,
  ENGINE_ERROR,
  PHOTO,
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
  vat?: string;
  wht?: string;
  discount?: string;
  outstanding?: string;
}

/** L6 fix: date range for กำหนดชำระ's native date input — the paper workbook
 * this register replaces genuinely contains a "1969" typo, almost certainly
 * a misclicked date-picker year spinner. Deliberately generous (unlike
 * ordinary expense dates, กำหนดชำระ is unbounded — past dates are the norm),
 * this only rules out a wildly wrong year; the server enforces the same
 * range authoritatively (src/server/server.ts's validateApRowInput). */
const DUE_DATE_MIN = "2000-01-01";
const DUE_DATE_MAX = "2100-12-31";

/** BLOCKER 2 fix: mirrors the server's authoritative apStore.AP_PHOTO_MAX_BYTES
 * (src/server/apStore.ts) — a cheap client-side pre-check at staging time so
 * an oversized file surfaces immediately instead of only after Save. The
 * server enforces the real cap regardless; this is a hint, not a guarantee. */
const STAGED_PHOTO_MAX_BYTES = 10 * 1024 * 1024;

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

  // รูปบิล (spec: photos are independent of payment state, upload never
  // blocks row save). ADD mode (row === null) stages files locally and
  // uploads them only AFTER the row itself is durably created — mirrors
  // EntryPage's stagedPhotos pattern. EDIT mode (row !== null) uploads
  // straight against the existing row id and shows the server's own
  // photos — mirrors EditDrawer's photos pattern. Only one of the two
  // arrays is ever active for a given drawer instance (add vs edit never
  // switches mid-session).
  const [stagedPhotos, setStagedPhotos] = useState<File[]>([]);
  const [photos, setPhotos] = useState<ExpensePhoto[]>(row?.photos ?? []);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const photoInputRef = useRef<HTMLInputElement>(null);

  // BLOCKER 2 fix: once ADD mode's row is created, this holds its id — a
  // staged photo failing to upload keeps the drawer open (see handleSave),
  // and this is what the per-photo retry buttons upload against. Stays null
  // in EDIT mode (row !== null already carries its own id) and before the
  // first Save attempt in ADD mode.
  const [createdRowId, setCreatedRowId] = useState<string | null>(null);

  // Fold e fix: URL.createObjectURL was called inline in JSX, minting a new
  // (never-revoked) blob URL on every render — including renders triggered
  // by unrelated field edits. Memoized so it only regenerates when the
  // staged list itself changes, with a matching cleanup effect that revokes
  // the previous batch (and the final batch on unmount) — the standard
  // create-object-url/revoke-on-cleanup pairing.
  const stagedPhotoUrls = useMemo(() => stagedPhotos.map((file) => URL.createObjectURL(file)), [stagedPhotos]);
  useEffect(() => {
    return () => {
      for (const url of stagedPhotoUrls) URL.revokeObjectURL(url);
    };
  }, [stagedPhotoUrls]);

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

  // H1b fix (probe-proven): categoryCode's local state above is seeded from
  // `row` only ONCE, on mount — a payment posted from WITHIN this drawer
  // (or, in principle, from anywhere else while it's open) can persist a
  // category server-side onto a previously null-category row, and
  // onPaymentChanged's refetch flows the updated value back in as a new
  // `row` prop, but without this resync the pill kept showing ไม่ระบุหมวด
  // and a subsequent บันทึก would then PATCH categoryCode back to null —
  // exactly what H1a's server-side lock now separately rejects, but the
  // client should never even offer a stale value in the first place. Keyed
  // on the PERSISTED categoryCode only (a primitive, not the `row` object
  // reference), so this never fires just because some other field (e.g.
  // outstanding after the same payment) changed, and never clobbers an
  // in-progress LOCAL edit the clerk hasn't saved yet.
  useEffect(() => {
    setCategoryCode(row?.categoryCode ?? null);
  }, [row?.categoryCode]);

  function handleCreditorChange(value: string) {
    setCreditor(value);
    // Prefill หมวดค่าใช้จ่าย/ในนาม from the creditor's most recent row (spec
    // §4 item 1) — only in ADD mode, so editing an existing row's creditor
    // name never silently overwrites a category the clerk already chose.
    if (row === null) {
      const hint = creditors.find((c) => c.creditor === value);
      if (hint) {
        // M3 fix: never overwrite an already-chosen category, and never
        // blank one with a null hint — see resolveCreditorHintCategoryCode.
        // Functional update so this reads the LATEST categoryCode rather
        // than one possibly-stale closure value.
        setCategoryCode((current) => resolveCreditorHintCategoryCode(current, hint.categoryCode));
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

    // M2 fix: an unparseable VAT/WHT/discount is a validation error shown to
    // the clerk, never silently treated as 0 (which used to let a typo like
    // "12.345" or "abc" quietly zero out a real tax/discount figure with no
    // feedback at all — these fields are optional, so an EMPTY field is
    // still fine and means "not entered").
    if (vatText.trim() !== "" && parseAmountToSatang(vatText) === null) next.vat = VALIDATION.amountInvalid;
    if (whtText.trim() !== "" && parseAmountToSatang(whtText) === null) next.wht = VALIDATION.amountInvalid;
    if (discountText.trim() !== "" && parseAmountToSatang(discountText) === null) next.discount = VALIDATION.amountInvalid;

    // RULING 1 (2026-07): categoryCode is now OPTIONAL on the row itself —
    // no requiredness check here any more. "ไม่ระบุหมวด" (categoryCode ===
    // null) is a legitimate, explicitly-chosen final state, not a
    // half-filled form. A payment against a null-category row still always
    // requires one — see ApPaymentForm's own picker/validation.

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
      categoryCode,
      note,
    };

    try {
      if (row) {
        await updateApRow(row.id, input);
        onSaved();
      } else if (createdRowId) {
        // BLOCKER 2 fix: a PREVIOUS Save already created the row and left
        // >= 1 staged photo un-uploaded (that's the only way this branch is
        // reachable — see below). Clicking Save again must retry those
        // photos, never call createApRow a second time and duplicate the
        // row.
        await uploadRemainingStagedPhotos(createdRowId);
      } else {
        const { id } = await createApRow(input);
        setCreatedRowId(id);
        await uploadRemainingStagedPhotos(id);
      }
    } catch (err) {
      if (err instanceof SessionExpiredError) return;
      if (err instanceof Error && err.message === "negative outstanding") {
        setErrors({ outstanding: AP_VALIDATION.negativeOutstanding });
      } else if (err instanceof Error && err.message === "category_locked_by_payments") {
        // H1a fix: the server rejected a categoryCode change (or null-ing)
        // on a row that already has >= 1 payment.
        setSaveError(AP_VALIDATION.categoryLockedByPayments);
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

  /** BLOCKER 2 fix: attempts one staged photo's upload against the
   * already-created row, never throwing — the caller (handleSave /
   * retryStagedPhoto) decides what to do with each outcome. Distinguishing
   * "session-expired" from a plain "failed" matters: a SessionExpiredError
   * means the global overlay is already taking over, so the caller stops
   * attempting further files rather than hammering a dead session. */
  async function attemptStagedUpload(rowId: string, file: File): Promise<"ok" | "session-expired" | "failed"> {
    try {
      await uploadApPhoto(rowId, file, file.name);
      return "ok";
    } catch (err) {
      if (err instanceof SessionExpiredError) return "session-expired";
      console.error("[ap-row-drawer] staged photo upload failed", err);
      return "failed";
    }
  }

  /** BLOCKER 2 fix: attempts every currently-staged photo against an
   * already-created row (used by handleSave, both on the row's FIRST save
   * and on a subsequent Save click that's really just retrying whatever
   * didn't upload the first time — see handleSave's `createdRowId` branch).
   * Anything that doesn't succeed (an explicit failure, OR anything not yet
   * attempted because a SessionExpiredError cut the loop short) stays
   * staged and keeps the drawer OPEN with a per-photo retry affordance,
   * instead of calling onSaved() (which would close it and lose this
   * in-memory list for good). */
  async function uploadRemainingStagedPhotos(rowId: string): Promise<void> {
    const remaining: File[] = [];
    let sessionExpired = false;
    for (const file of stagedPhotos) {
      if (sessionExpired) {
        remaining.push(file);
        continue;
      }
      const outcome = await attemptStagedUpload(rowId, file);
      if (outcome !== "ok") remaining.push(file);
      if (outcome === "session-expired") sessionExpired = true;
    }
    setStagedPhotos(remaining);
    if (remaining.length > 0) {
      setPhotoError(AP_VALIDATION.stagedPhotosNotUploaded(remaining.length));
    } else {
      onSaved();
    }
  }

  /** Per-photo retry button (BLOCKER 2 fix) — mirrors EntryPage's
   * photo-retry-chip resilience pattern, at individual-photo granularity
   * (this drawer already renders one thumbnail per staged file, unlike
   * EntryPage's single count+retry chip). Once every staged photo has
   * uploaded, the save flow is finally complete — proceeds to onSaved(). */
  async function retryStagedPhoto(index: number) {
    const file = stagedPhotos[index];
    if (!file || !createdRowId) return;
    setPhotoBusy(true);
    const outcome = await attemptStagedUpload(createdRowId, file);
    setPhotoBusy(false);
    if (outcome !== "ok") return;
    const next = stagedPhotos.filter((_, i) => i !== index);
    setStagedPhotos(next);
    if (next.length === 0) {
      setPhotoError(null);
      onSaved();
    } else {
      setPhotoError(AP_VALIDATION.stagedPhotosNotUploaded(next.length));
    }
  }

  function addStagedFiles(files: FileList | File[] | null) {
    if (!files) return;
    const list = Array.from(files);
    if (list.length === 0) return;
    // BLOCKER 2 fix: a cheap staging-time pre-check so most failures surface
    // immediately instead of only after Save — uses the SAME shared
    // allow-list function the server's upload gate does
    // (src/shared/apTypes.ts's apPhotoExtForFilename), so client and server
    // can never silently disagree about what counts as an accepted photo.
    // This is a hint, not a guarantee: the server still enforces both checks
    // authoritatively.
    const accepted: File[] = [];
    let rejected: "size" | "type" | null = null;
    for (const file of list) {
      if (file.size > STAGED_PHOTO_MAX_BYTES) {
        rejected = rejected ?? "size";
        continue;
      }
      if (!apPhotoExtForFilename(file.name)) {
        rejected = rejected ?? "type";
        continue;
      }
      accepted.push(file);
    }
    if (accepted.length > 0) setStagedPhotos((prev) => [...prev, ...accepted]);
    if (rejected === "size") setPhotoError(AP_VALIDATION.photoTooLarge);
    else if (rejected === "type") setPhotoError(AP_VALIDATION.photoUnsupportedType);
  }

  async function handleAddFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    if (row === null) {
      addStagedFiles(files);
      return;
    }
    setPhotoBusy(true);
    setPhotoError(null);
    for (const file of Array.from(files)) {
      try {
        const uploaded = await uploadApPhoto(row.id, file, file.name);
        setPhotos((prev) => [...prev, uploaded]);
      } catch (err) {
        if (err instanceof SessionExpiredError) break;
        if (err instanceof Error && err.message === "photo too large") setPhotoError(AP_VALIDATION.photoTooLarge);
        else if (err instanceof Error && err.message === "unsupported photo type") {
          setPhotoError(AP_VALIDATION.photoUnsupportedType);
        } else setPhotoError(ENGINE_ERROR.message);
      }
    }
    setPhotoBusy(false);
  }

  async function handleRemovePhoto(photoId: string) {
    if (!row) return;
    if (!window.confirm(EDIT_DRAWER.confirmDelete)) return;
    setPhotoBusy(true);
    setPhotoError(null);
    try {
      await deleteApPhoto(row.id, photoId);
      setPhotos((prev) => prev.filter((p) => p.id !== photoId));
    } catch (err) {
      if (!(err instanceof SessionExpiredError)) setPhotoError(ENGINE_ERROR.message);
    } finally {
      setPhotoBusy(false);
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
          {/* Owner rule: ชื่อเจ้าหนี้ must always be fully readable — wraps to
              multiple lines instead of clipping (no `truncate`), same as the
              register's own grid/card rows. */}
          <h2 className="break-words text-sm font-semibold text-ink">{heading}</h2>
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
              {errors.vat && <p className="mt-1 text-xs text-bad">{errors.vat}</p>}
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
              {errors.wht && <p className="mt-1 text-xs text-bad">{errors.wht}</p>}
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
              {errors.discount && <p className="mt-1 text-xs text-bad">{errors.discount}</p>}
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
                  min={DUE_DATE_MIN}
                  max={DUE_DATE_MAX}
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
              {/* RULING 1: category is optional on the row — "ไม่ระบุหมวด"
                  is an explicit, selectable state (not just leaving the
                  picker untouched), so it renders as its own pill alongside
                  the 21-leaf grid rather than inside CategoryPicker itself
                  (that component stays required-only, unchanged, for the
                  entry/edit screens that still mandate a real category). */}
              <button
                type="button"
                role="radio"
                aria-checked={categoryCode === null}
                onClick={() => setCategoryCode(null)}
                className={
                  "mb-2 rounded-full border px-2.5 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-brand-500/40 " +
                  (categoryCode === null
                    ? "border-brand-500 bg-brand-50 text-brand-700"
                    : "border-line-strong bg-panel text-ink-muted hover:bg-tint")
                }
              >
                {AP_FIELDS.categoryUnset}
              </button>
              <CategoryPicker value={categoryCode} onChange={setCategoryCode} recentCodes={recentCodes} />
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

            <div>
              <label className="mb-1.5 block text-xs font-semibold text-ink-muted">{AP_FIELDS.photos}</label>
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                multiple
                className="hidden"
                onChange={(e) => {
                  void handleAddFiles(e.target.files);
                  e.target.value = "";
                }}
              />
              {row === null
                ? stagedPhotos.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {stagedPhotos.map((file, index) => (
                        <div key={`${file.name}-${index}`} className="flex flex-col items-center gap-1">
                          <img
                            src={stagedPhotoUrls[index]}
                            alt=""
                            className="h-16 w-16 rounded-md border border-line object-cover"
                          />
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => {
                                const next = stagedPhotos.filter((_, i) => i !== index);
                                setStagedPhotos(next);
                                // BLOCKER 2 fix: once the row is already
                                // created (a prior save hit a photo
                                // failure) and the clerk removes the last
                                // still-unsent photo instead of retrying
                                // it, the save flow is finally complete.
                                if (createdRowId && next.length === 0) {
                                  setPhotoError(null);
                                  onSaved();
                                }
                              }}
                              className="text-xs text-bad hover:underline"
                            >
                              {PHOTO.remove}
                            </button>
                            {createdRowId && (
                              <button
                                type="button"
                                onClick={() => void retryStagedPhoto(index)}
                                disabled={photoBusy}
                                className="text-xs font-medium text-brand-500 hover:underline disabled:opacity-50"
                              >
                                {PHOTO.retry}
                              </button>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )
                : photos.length > 0 && (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {photos.map((photo) => (
                        <div key={photo.id} className="flex flex-col items-center gap-1">
                          <button type="button" onClick={() => setLightboxUrl(photo.url)}>
                            <img src={photo.url} alt="" className="h-16 w-16 rounded-md border border-line object-cover" />
                          </button>
                          <button
                            type="button"
                            onClick={() => void handleRemovePhoto(photo.id)}
                            disabled={photoBusy}
                            className="text-xs text-bad hover:underline disabled:opacity-50"
                          >
                            {PHOTO.remove}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
              <button
                type="button"
                onClick={() => photoInputRef.current?.click()}
                disabled={photoBusy}
                className="h-11 rounded-md border border-line-strong bg-panel px-4 text-sm font-medium text-ink hover:bg-tint focus:outline-none focus:ring-2 focus:ring-brand-500/40 disabled:opacity-50"
              >
                {PHOTO.choose}
              </button>
              {photoError && <p className="mt-1 text-xs text-bad">{photoError}</p>}
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
          // RULING 1: the row's OWN categoryCode can be null at this point
          // (that's exactly when ApPaymentForm renders its own picker) —
          // `postedCategoryCode` is the one actually used to post (either
          // the row's pre-existing category, or the one just collected),
          // never the possibly-null `row.categoryCode` closed over here.
          onPosted={(dateIso, postedCategoryCode) => {
            setShowPaymentForm(false);
            setPostedNotice(AP_PAY.posted(categoryByCode(postedCategoryCode).label, isoToBuddhist(dateIso)));
            onPaymentChanged();
            setTimeout(() => setPostedNotice(null), 4000);
          }}
        />
      )}

      {lightboxUrl && <PhotoLightbox url={lightboxUrl} onClose={() => setLightboxUrl(null)} />}
    </div>
  );
}
