import { describe, expect, test } from "bun:test";
import {
  apTagName,
  buildApPaymentComment,
  computeGross,
  computeOutstanding,
  deriveSettledAt,
  deriveStatus,
  derivePaymentKind,
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

  test("null with no payments at all, even if outstanding is somehow <= 0", () => {
    expect(deriveSettledAt([], 0)).toBeNull();
  });

  test("the newest payment date once outstanding is settled", () => {
    const payments = [{ date: "2026-07-01" }, { date: "2026-07-21" }, { date: "2026-07-10" }];
    expect(deriveSettledAt(payments, 0)).toBe("2026-07-21");
  });

  test("settled at a negative outstanding too (over-discount edge case)", () => {
    expect(deriveSettledAt([{ date: "2026-07-05" }], -100)).toBe("2026-07-05");
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
