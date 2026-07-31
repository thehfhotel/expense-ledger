import { describe, expect, test } from "bun:test";
import {
  apPhotoUrl,
  apRowPhotoCount,
  apTagName,
  buildApPaymentComment,
  computeGross,
  computeOutstanding,
  deriveSettledAt,
  deriveStatus,
  derivePaymentKind,
  paymentKindSuffix,
  paymentNeedsCategoryPicker,
  resolveCreditorHintCategoryCode,
  statusRank,
  type ApPayment,
} from "./apTypes.ts";

function payment(overrides: Partial<ApPayment> = {}): ApPayment {
  return {
    id: "p1",
    date: "2026-07-10",
    amountSatang: 1000,
    paymentMethod: "cash",
    kind: "full",
    installmentNumber: null,
    payerEmail: "clerk@thehfhotel.org",
    transactionId: "1",
    ...overrides,
  };
}

describe("computeGross", () => {
  test("amount alone when vat/wht are both null", () => {
    expect(computeGross(10_000, null, null)).toBe(10_000);
  });

  test("adds vat and subtracts withholding tax", () => {
    expect(computeGross(10_000, 700, 300)).toBe(10_400);
  });

  test("vat only", () => {
    expect(computeGross(10_000, 700, null)).toBe(10_700);
  });
});

describe("computeOutstanding", () => {
  test("gross minus discount when there are no payments yet", () => {
    expect(computeOutstanding(10_000, [], 500)).toBe(9_500);
  });

  test("subtracts every payment (มัดจำ + งวด) and the discount", () => {
    const payments = [{ amountSatang: 3_000 }, { amountSatang: 2_000 }];
    expect(computeOutstanding(10_000, payments, 1_000)).toBe(4_000);
  });

  test("can go to exactly zero when fully paid", () => {
    expect(computeOutstanding(10_000, [{ amountSatang: 10_000 }], 0)).toBe(0);
  });
});

describe("deriveSettledAt", () => {
  test("null while outstanding is still positive", () => {
    expect(deriveSettledAt([{ date: "2026-07-01" }], 100)).toBeNull();
  });

  test("null with no payments and no filedDate fallback provided (2-arg call)", () => {
    expect(deriveSettledAt([], 0)).toBeNull();
  });

  test("H3 fix: falls back to filedDate when settled with ZERO payments (credit-note case — a discount/WHT alone brought outstanding to <= 0)", () => {
    expect(deriveSettledAt([], 0, "2026-07-15")).toBe("2026-07-15");
  });

  test("H3 fix: the filedDate fallback also applies at a negative outstanding with zero payments", () => {
    expect(deriveSettledAt([], -50, "2026-07-15")).toBe("2026-07-15");
  });

  test("the newest payment date once outstanding is settled", () => {
    const payments = [{ date: "2026-07-01" }, { date: "2026-07-21" }, { date: "2026-07-10" }];
    expect(deriveSettledAt(payments, 0)).toBe("2026-07-21");
  });

  test("settled at a negative outstanding too (over-discount edge case)", () => {
    expect(deriveSettledAt([{ date: "2026-07-05" }], -100)).toBe("2026-07-05");
  });

  test("a payment date wins over filedDate even when both are present", () => {
    expect(deriveSettledAt([{ date: "2026-07-05" }], 0, "2026-01-01")).toBe("2026-07-05");
  });
});

describe("deriveStatus", () => {
  const today = "2026-07-15";

  test("settled beats every date rule, including an overdue due date", () => {
    expect(deriveStatus("2026-01-01", 0, today)).toBe("settled");
    expect(deriveStatus("2026-01-01", -50, today)).toBe("settled");
  });

  test("overdue when due date is strictly before today", () => {
    expect(deriveStatus("2026-07-14", 100, today)).toBe("overdue");
  });

  test("ใกล้ครบกำหนด window is inclusive of today and today+7", () => {
    expect(deriveStatus(today, 100, today)).toBe("dueSoon");
    expect(deriveStatus("2026-07-22", 100, today)).toBe("dueSoon");
  });

  test("just past the 7-day window is ค้างจ่าย, not dueSoon", () => {
    expect(deriveStatus("2026-07-23", 100, today)).toBe("open");
  });

  test("a blank due date falls back to ค้างจ่าย (open), never overdue or dueSoon", () => {
    expect(deriveStatus(null, 100, today)).toBe("open");
  });
});

describe("statusRank", () => {
  test("orders เกินกำหนด < ใกล้ครบกำหนด < ค้างจ่าย < จ่ายครบ", () => {
    expect(statusRank("overdue")).toBeLessThan(statusRank("dueSoon"));
    expect(statusRank("dueSoon")).toBeLessThan(statusRank("open"));
    expect(statusRank("open")).toBeLessThan(statusRank("settled"));
  });
});

describe("derivePaymentKind", () => {
  test("the first payment on a row is always มัดจำ (deposit), unless it settles the row", () => {
    expect(derivePaymentKind([], false)).toEqual({ kind: "deposit", installmentNumber: null });
  });

  test("a payment that settles the row is always full, even with no history", () => {
    expect(derivePaymentKind([], true)).toEqual({ kind: "full", installmentNumber: null });
  });

  test("the first partial after a deposit is งวดที่ 1", () => {
    const existing = [payment({ kind: "deposit" })];
    expect(derivePaymentKind(existing, false)).toEqual({ kind: "installment", installmentNumber: 1 });
  });

  test("subsequent partials increment N, counting only prior installments (not the deposit)", () => {
    const existing = [payment({ kind: "deposit" }), payment({ kind: "installment", installmentNumber: 1 })];
    expect(derivePaymentKind(existing, false)).toEqual({ kind: "installment", installmentNumber: 2 });
  });

  test("a settling payment after partial history is still full, not another installment", () => {
    const existing = [payment({ kind: "deposit" }), payment({ kind: "installment", installmentNumber: 1 })];
    expect(derivePaymentKind(existing, true)).toEqual({ kind: "full", installmentNumber: null });
  });
});

describe("apTagName", () => {
  test("formats as ap:<rowId>", () => {
    expect(apTagName("abc-123")).toBe("ap:abc-123");
  });
});

describe("paymentKindSuffix (L3 fix — split out so a truncation step can keep this intact)", () => {
  test("no suffix for a full settlement", () => {
    expect(paymentKindSuffix("full", null)).toBe("");
  });

  test("มัดจำ for a deposit", () => {
    expect(paymentKindSuffix("deposit", null)).toBe(" (มัดจำ)");
  });

  test("งวดที่ N for an installment", () => {
    expect(paymentKindSuffix("installment", 3)).toBe(" (งวดที่ 3)");
  });
});

describe("paymentNeedsCategoryPicker (RULING 1 — payments still require a category)", () => {
  test("true when the row has no category yet", () => {
    expect(paymentNeedsCategoryPicker(null)).toBe(true);
  });

  test("false once the row already carries a category", () => {
    expect(paymentNeedsCategoryPicker("commission-booking")).toBe(false);
  });
});

describe("resolveCreditorHintCategoryCode (M3 fix — creditor-hint prefill never overwrites a chosen category)", () => {
  test("applies the hint when there is no current selection and the hint is non-null", () => {
    expect(resolveCreditorHintCategoryCode(null, "commission-booking")).toBe("commission-booking");
  });

  test("leaves a null current selection null when the hint is also null", () => {
    expect(resolveCreditorHintCategoryCode(null, null)).toBeNull();
  });

  test("never overwrites an already-chosen category with a DIFFERENT hint", () => {
    expect(resolveCreditorHintCategoryCode("housekeeping", "commission-booking")).toBe("housekeeping");
  });

  test("never blanks an already-chosen category just because the hint is null", () => {
    expect(resolveCreditorHintCategoryCode("housekeeping", null)).toBe("housekeeping");
  });
});

describe("buildApPaymentComment", () => {
  test("no suffix for a full settlement", () => {
    expect(buildApPaymentComment("Booking.com", "ค่าคอมมิชชั่น ก.ค.", "full", null)).toBe(
      "Booking.com - ค่าคอมมิชชั่น ก.ค.",
    );
  });

  test("มัดจำ suffix for a deposit", () => {
    expect(buildApPaymentComment("หจก.บุญดี", "ค่าซ่อมแซม", "deposit", null)).toBe(
      "หจก.บุญดี - ค่าซ่อมแซม (มัดจำ)",
    );
  });

  test("งวดที่ N suffix for an installment", () => {
    expect(buildApPaymentComment("การไฟฟ้า", "ค่าไฟฟ้า มิ.ย.", "installment", 2)).toBe(
      "การไฟฟ้า - ค่าไฟฟ้า มิ.ย. (งวดที่ 2)",
    );
  });
});

describe("apPhotoUrl", () => {
  test("builds the stable GET /api/ap/photos/:photoId path", () => {
    expect(apPhotoUrl("abc-123")).toBe("/api/ap/photos/abc-123");
  });
});

describe("apRowPhotoCount — the register row's photo-count indicator (spec: show only when > 0)", () => {
  test("null (render nothing) for a row with zero photos", () => {
    expect(apRowPhotoCount([])).toBeNull();
  });

  test("the count for a row with one photo", () => {
    expect(apRowPhotoCount([{ id: "p1" }])).toBe(1);
  });

  test("the count for a row with several photos", () => {
    expect(apRowPhotoCount([{ id: "p1" }, { id: "p2" }, { id: "p3" }])).toBe(3);
  });
});
