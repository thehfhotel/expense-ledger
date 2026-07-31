// Every repeated Thai string in the app lives here (frontend spec §8), so
// two screens can never drift into two different words for the same thing.
// Category labels come from src/shared/categories.ts; month/date words come
// from the ported src/shared/date.ts — neither is re-declared here.

export const APP_TITLE = "บันทึกค่าใช้จ่าย";

export const NAV = {
  entry: "บันทึกรายจ่าย",
  month: "สรุปเดือน",
  ap: "ค้างจ่าย",
};

/** document.title = `${APP_TITLE} · ${screen}` — see App.tsx's title effect. */
export function pageTitle(screen: string): string {
  return `${APP_TITLE} · ${screen}`;
}

export const FIELD_LABELS = {
  date: "วันที่",
  amount: "จำนวนเงิน",
  category: "หมวดค่าใช้จ่าย",
  paymentMethod: "จ่ายด้วย",
  item: "รายการ / หมายเหตุ",
  photo: "รูปบิล",
};

export const PAYMENT_METHOD_LABELS = {
  cash: "เงินสด",
  bank: "ธนาคาร",
};

export const CATEGORY_PICKER = {
  searchPlaceholder: "ค้นหาหมวด",
  recentHeading: "ล่าสุด",
};

export const ITEM_PLACEHOLDER_DEFAULT = "รายละเอียดรายการ (ไม่บังคับ)";
/** Codes 9-16 (the building-scoped water/electricity/phone leaves) get a
 * placeholder that nudges the clerk to capture the billing month, since
 * there is no dedicated field for it (frontend spec §2.5). */
export const ITEM_PLACEHOLDER_BILLING_MONTH = "เช่น ค่าไฟ สายชล มี.ค. 69";

export const AMOUNT_PLACEHOLDER = "0.00";
export const AMOUNT_ARIA_LABEL = "จำนวนเงิน (บาท)";

export const PHOTO = {
  choose: "เลือกรูปบิล",
  remove: "ลบรูป",
  notUploaded: "รูปยังไม่ขึ้น",
  retry: "ลองอีกครั้ง",
  close: "ปิด",
};

export const SAVE = {
  idle: "บันทึก",
  saving: "กำลังบันทึก...",
  saved: "บันทึกแล้ว",
};

export const DAY_STRIP = {
  /** "รายการวันที่ {วันที่}" — `dateLabel` is isoToThaiLong(date). */
  heading: (dateLabel: string) => `รายการวันที่ ${dateLabel}`,
  empty: "ยังไม่มีรายการวันนี้",
};

export const MONTH_HEADER = {
  total: "รวมทั้งเดือน",
  backToCurrent: "กลับไปเดือนนี้",
  prevMonth: "เดือนก่อนหน้า",
  nextMonth: "เดือนถัดไป",
};

export const CHECKLIST = {
  heading: "รายการที่ต้องมีทุกเดือน",
  /** "บันทึกแล้ว {n} / 17" */
  progress: (n: number, total: number) => `บันทึกแล้ว ${n} / ${total}`,
  missing: "ยังไม่ได้บันทึก",
  record: "บันทึก",
  /** "{n} รายการ" */
  countItems: (n: number) => `${n} รายการ`,
};

export const TOTALS = {
  heading: "รวมตามหมวด",
  category: "หมวด",
  count: "จำนวนรายการ",
  total: "รวม",
  grandTotal: "รวมทั้งสิ้น",
};

export const ITEM_LIST = {
  heading: "รายการทั้งหมด",
  date: "วันที่",
  paymentMethod: "จ่ายด้วย",
  photo: "รูป",
  recordedBy: "ผู้บันทึก",
};

export const EMPTY_MONTH = {
  message: "ยังไม่มีรายการในเดือนนี้ - เริ่มจากบันทึกบิลใบแรก",
  cta: NAV.entry,
};

export const EDIT_DRAWER = {
  heading: "แก้ไขรายการ",
  save: "บันทึกการแก้ไข",
  cancel: "ยกเลิก",
  delete: "ลบรายการ",
  confirmDelete: "ลบรายการนี้ใช่หรือไม่",
};

export const PAST_MONTH_LOCK = "แก้ไขได้เฉพาะเดือนปัจจุบัน";

export const VALIDATION = {
  amountRequired: "กรอกจำนวนเงิน",
  amountInvalid: "จำนวนเงินไม่ถูกต้อง",
  categoryRequired: "เลือกหมวดค่าใช้จ่าย",
  dateNotFuture: "วันที่ต้องไม่เกินวันนี้",
};

export const ENGINE_ERROR = {
  message: "บันทึกไม่สำเร็จ — ระบบบัญชีไม่ตอบสนอง",
  retry: "ลองอีกครั้ง",
};

/** L1 fix: distinct from ENGINE_ERROR — a LOCAL store failure (the AP
 * register's own sqlite, or any other server-side store) is not "the ledger
 * engine didn't answer," so it gets its own Thai wording rather than either
 * a raw English error token or the engine-unreachable message. */
export const AP_STORE_ERROR = {
  message: "โหลดข้อมูลไม่สำเร็จ — ระบบค้างจ่ายมีปัญหา",
  detail: "ระบบค้างจ่ายมีปัญหา",
};

/** H2 fix: shown when a clerk tries to edit/delete an ordinary expense entry
 * that the AP register actually manages (carries an `ap:` tag) — the server
 * 409s `{ "error": "ap_managed" }`; this is the Thai text pointing the clerk
 * at the right place instead of a generic failure. */
export const AP_MANAGED = {
  message: "รายการนี้เป็นรายการค้างจ่าย — แก้ไขหรือลบได้จากแท็บ ค้างจ่าย เท่านั้น",
};

export const SESSION_ERROR = {
  title: "หมดเวลาเข้าใช้งาน",
  body: "กรุณาเข้าสู่ระบบใหม่",
  reload: "เข้าสู่ระบบใหม่",
};

export const LOADING = "กำลังโหลด...";
export const LOAD_FAILED = "โหลดข้อมูลไม่สำเร็จ";
/** "โหลดข้อมูลไม่สำเร็จ: {error}" — the sibling's page-level load-failure block. */
export function loadFailedDetail(error: string): string {
  return `${LOAD_FAILED}: ${error}`;
}
export const DELETE_FAILED = "ลบรายการไม่สำเร็จ ลองใหม่อีกครั้ง";

export const EMPTY_VALUE = "-";

// ── AP register ("ค้างจ่าย" — the third tab, frontend spec §8) ────────────

export const AP = {
  nav: "ค้างจ่าย",
  add: "เพิ่มรายการค้างจ่าย",
  heading: "รายการค้างจ่าย",
  totalOutstanding: "รวมยอดค้างชำระ",
  overdueCount: (n: number) => `เกินกำหนด ${n} รายการ`,
  filterOpen: "ค้างจ่าย",
  filterAll: "ทั้งหมด",
  filterMonth: "รายเดือน",
};

export const AP_FIELDS = {
  creditor: "ชื่อเจ้าหนี้",
  item: "รายการ",
  amount: "จำนวนเงิน",
  vat: "VAT 7%",
  wht: "ภาษีหัก ณ ที่จ่าย",
  gross: "จำนวนรวม",
  deposit: "มัดจำ",
  installment: (n: number) => `งวดที่ ${n}`,
  discount: "ส่วนลด",
  outstanding: "ยอดค้างชำระ",
  dueDate: "กำหนดชำระ",
  entity: "ในนาม",
  status: "สถานะ",
  note: "หมายเหตุ",
  category: "หมวดค่าใช้จ่าย",
  paidBy: "ผู้จ่าย",
  /** RULING 1: the explicit "no category yet" state — a real, chosen value
   * on an AP row, never a hidden default. Doubles as the neutral chip/dash
   * shown wherever a null categoryCode renders. */
  categoryUnset: "ไม่ระบุหมวด",
  /** รูปบิล section heading (ApRowDrawer) — bill/invoice photos, independent
   * of payment state. */
  photos: "รูปบิล",
  /** "รูปบิล (2)" — the register row's small photo-count indicator, shown
   * only when apRowPhotoCount returns non-null (spec: "> 0"). */
  photoCount: (n: number) => `รูปบิล (${n})`,
};

export const AP_STATUS = {
  open: "ค้างจ่าย",
  dueSoon: "ใกล้ครบกำหนด",
  overdue: "เกินกำหนด",
  settled: "จ่ายครบ",
  /** "จ่ายแล้ว 21/7/2569" — the sheet's own wording. */
  settledOn: (dateLabel: string) => `จ่ายแล้ว ${dateLabel}`,
};

export const AP_PAY = {
  action: "ชำระ",
  heading: "บันทึกการชำระ",
  date: "วันที่จ่าย",
  amount: "จำนวนที่จ่าย",
  payFull: "ชำระทั้งหมด",
  submit: "บันทึกการชำระ",
  cancel: "ยกเลิก",
  history: "ประวัติการชำระ",
  historyEmpty: "ยังไม่มีการชำระ",
  undo: "ยกเลิกการชำระ",
  kindFull: "จ่ายครบ",
  vatAuto: "คิด VAT 7%",
  /** Under the category picker — the "no re-typing" promise. */
  autoPostNotice: "เมื่อบันทึกการชำระ ระบบจะลงบัญชีให้อัตโนมัติในหมวดนี้ ไม่ต้องบันทึกซ้ำที่หน้าบันทึกรายจ่าย",
  posted: (category: string, dateLabel: string) => `ลงบัญชีในหมวด ${category} วันที่ ${dateLabel} แล้ว`,
};

export const AP_EMPTY = {
  none: "ยังไม่มีรายการค้างจ่าย - เริ่มจากเพิ่มบิลใบแรก",
  noneOpen: "ไม่มีรายการค้างจ่าย - จ่ายครบทุกรายการแล้ว",
  noneMonth: "ไม่มีรายการในเดือนนี้",
};

export const AP_VALIDATION = {
  creditorRequired: "กรอกชื่อเจ้าหนี้",
  itemRequired: "กรอกรายการ",
  negativeOutstanding: "ยอดค้างชำระติดลบ - ตรวจสอบจำนวนเงินหรือส่วนลด",
  payTooMuch: "จำนวนที่จ่ายเกินยอดค้างชำระ",
  hasPayments: "รายการนี้มีการชำระแล้ว ลบไม่ได้ - ให้ยกเลิกการชำระก่อน",
  undoLocked: "ยกเลิกไม่ได้ - รายการบัญชีอยู่ในเดือนที่ปิดแล้ว",
  /** RULING 1: shown in the payment form when the row has no category yet
   * and the clerk hasn't picked one — a payment can never post without a
   * real category, matching the server's distinct "category required for
   * payment" 400. */
  categoryRequiredForPayment: "เลือกหมวดค่าใช้จ่ายก่อนบันทึกการชำระ",
  /** H1a fix: shown in the edit drawer when a save would change (including
   * null-ing) categoryCode on a row that already has >= 1 payment — matches
   * the server's distinct "category_locked_by_payments" 409. */
  categoryLockedByPayments: "หมวดถูกล็อกแล้วเนื่องจากมีการชำระ จัดการหมวดได้เฉพาะก่อนการชำระครั้งแรก",
  /** L2 fix: shown in the payment form for the server's "invalid
   * categoryCode" 400 — distinct from the generic engine-error fallback, so
   * a malformed category value reads as a validation problem, not the
   * ledger engine being unreachable. */
  invalidCategoryForPayment: "หมวดค่าใช้จ่ายไม่ถูกต้อง ลองเลือกใหม่อีกครั้ง",
  /** POST /api/ap/rows/:id/photos's 413 — distinct from the generic
   * ap_store_error fallback so an oversized file reads as a validation
   * problem, not a system failure. */
  photoTooLarge: "ไฟล์รูปใหญ่เกินไป (จำกัดไม่เกิน 10 MB)",
  /** Same route's 415. RULING 3 (2026-07, owner decision): HEIC dropped
   * entirely — browsers cannot render a stored HEIC file back to the clerk,
   * so this no longer lists it as accepted. */
  photoUnsupportedType: "ไม่รองรับไฟล์ประเภทนี้ — ใช้ได้เฉพาะ JPEG, PNG, WEBP",
  /** BLOCKER 2 fix: shown in the add-mode drawer when >= 1 staged photo
   * didn't make it up after the row itself was already saved (an explicit
   * upload failure, or one never attempted because a SessionExpiredError cut
   * the loop short) — the drawer stays open with a retry affordance per
   * photo instead of closing and leaving the clerk unable to tell a lost
   * photo from a saved one. */
  stagedPhotosNotUploaded: (n: number) => `รูปบิล ${n} รูปยังไม่ได้แนบ - ลองใหม่อีกครั้ง`,
};

export const AP_ENTITIES = ["บจก.สายชล เฮอริเทจ", "HF Ville", "HF", "SCM", "บจก.สายชล เฮอริเทจ ทหารไทย"];
