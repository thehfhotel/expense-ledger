// Every repeated Thai string in the app lives here (frontend spec §8), so
// two screens can never drift into two different words for the same thing.
// Category labels come from src/shared/categories.ts; month/date words come
// from the ported src/shared/date.ts — neither is re-declared here.

export const APP_TITLE = "บันทึกค่าใช้จ่าย";

export const NAV = {
  entry: "บันทึกรายจ่าย",
  month: "สรุปเดือน",
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
