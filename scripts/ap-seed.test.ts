// Unit tests for scripts/lib/ap-seed.ts's pure selection/mapping rules.
// Every fixture below uses synthetic creditor names, amounts, and dates —
// NEVER the real production workbook's figures (this is a public repo; see
// CLAUDE.md's public-repo hygiene rule and scripts/seed-ap-2026-07.ts's
// header comment).

import { describe, expect, test } from "bun:test";
import {
  checkRowIntegrity,
  classifyNote,
  evaluateWorkbookRow,
  isOpenUnpaidRow,
  parseSeedDueDate,
  resolveSeedCategory,
  toApRowInput,
  type SeedRow,
} from "./lib/ap-seed.ts";

describe("isOpenUnpaidRow", () => {
  test("selects a row with outstanding > 0 and no paid marker", () => {
    expect(isOpenUnpaidRow(1000, "")).toBe(true);
    expect(isOpenUnpaidRow(1000, "เดือน10")).toBe(true);
  });

  test("excludes a row marked paid, even if outstanding still shows > 0", () => {
    expect(isOpenUnpaidRow(1000, "จ่ายแล้ว 1/1/2569")).toBe(false);
  });

  test("excludes a row with zero or negative outstanding", () => {
    expect(isOpenUnpaidRow(0, "")).toBe(false);
    expect(isOpenUnpaidRow(-5, "")).toBe(false);
  });
});

describe("resolveSeedCategory", () => {
  test("maps Booking.com to commission-booking", () => {
    expect(resolveSeedCategory("Booking.com", "some item")).toBe("commission-booking");
  });

  test("maps expedia (any case) to commission-expedia", () => {
    expect(resolveSeedCategory("expedia group", "x")).toBe("commission-expedia");
    expect(resolveSeedCategory("Expedia Group", "x")).toBe("commission-expedia");
  });

  test("maps a บุญดี-family creditor, or any item mentioning ของใช้แม่บ้าน, to housekeeping", () => {
    expect(resolveSeedCategory("หจก.บุญดี 99", "วางบิล")).toBe("housekeeping");
    expect(resolveSeedCategory("ร้านอื่น", "ซื้อของใช้แม่บ้าน")).toBe("housekeeping");
  });

  test("returns null for any creditor outside the mapped set", () => {
    expect(resolveSeedCategory("ร้านทั่วไป", "ซ่อมแอร์")).toBeNull();
  });
});

describe("checkRowIntegrity", () => {
  test("passes when outstanding matches amount+vat-wht-discount exactly", () => {
    const result = checkRowIntegrity({
      amountBaht: 1000,
      vatBaht: 0,
      whtBaht: 0,
      discountBaht: 0,
      outstandingBaht: 1000,
      depositBaht: 0,
      installment1Baht: 0,
      installment2Baht: 0,
      installment3Baht: 0,
    });
    expect(result.ok).toBe(true);
  });

  test("passes when a withholding tax fully explains the difference", () => {
    const result = checkRowIntegrity({
      amountBaht: 1000,
      vatBaht: 0,
      whtBaht: 30,
      discountBaht: 0,
      outstandingBaht: 970,
      depositBaht: 0,
      installment1Baht: 0,
      installment2Baht: 0,
      installment3Baht: 0,
    });
    expect(result.ok).toBe(true);
  });

  test("fails on an unexplained discrepancy between L and the computed amount", () => {
    const result = checkRowIntegrity({
      amountBaht: 1000,
      vatBaht: 0,
      whtBaht: 0,
      discountBaht: 0,
      outstandingBaht: 955, // 45 baht short, nothing in G-K explains it
      depositBaht: 0,
      installment1Baht: 0,
      installment2Baht: 0,
      installment3Baht: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/does not match/);
  });

  test("fails when the workbook already recorded a partial payment (deposit/installment)", () => {
    const result = checkRowIntegrity({
      amountBaht: 1000,
      vatBaht: 0,
      whtBaht: 0,
      discountBaht: 0,
      outstandingBaht: 500,
      depositBaht: 500,
      installment1Baht: 0,
      installment2Baht: 0,
      installment3Baht: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/already records/);
  });
});

describe("parseSeedDueDate", () => {
  test("blank cell -> null due date, clean flag", () => {
    expect(parseSeedDueDate("")).toEqual({ dueDate: null, flag: "clean" });
    expect(parseSeedDueDate(undefined)).toEqual({ dueDate: null, flag: "clean" });
  });

  test("a native numeric Excel serial (Buddhist year) converts to a CE ISO date", () => {
    // 244561 is the same serial family verified in scripts/lib/dates.ts's own
    // header comment (serial 244531 -> {2569, 7, 1}); 244561 is 30 days
    // later -> {2569, 7, 31} -> CE 2026-07-31.
    expect(parseSeedDueDate(244561)).toEqual({ dueDate: "2026-07-31", flag: "clean" });
  });

  test("the same serial stored as TEXT still parses, flagged date-fixed", () => {
    expect(parseSeedDueDate("244561")).toEqual({ dueDate: "2026-07-31", flag: "date-fixed" });
  });

  test("a malformed non-numeric string leaves the due date blank, flagged date-unparseable", () => {
    expect(parseSeedDueDate("25//6/69")).toEqual({ dueDate: null, flag: "date-unparseable" });
  });

  test("a serial decoding outside the sane year range is rejected", () => {
    // Serial 1 decodes to a real year far outside 2000-2100 once the -543
    // Buddhist offset is applied — never trusted.
    expect(parseSeedDueDate(1).flag).toBe("date-unparseable");
  });
});

describe("classifyNote", () => {
  test("blank status text -> clean", () => {
    expect(classifyNote("")).toEqual({ note: "", flags: ["clean"] });
  });

  test("a bare เดือนN marker -> เดือนX-marked", () => {
    expect(classifyNote("เดือน10")).toEqual({ note: "เดือน10", flags: ["เดือนX-marked"] });
  });

  test("a โทรตามยอด chase note -> chase-note", () => {
    const text = "โทรตามยอด 1/1/69 แจ้งแล้ว";
    expect(classifyNote(text)).toEqual({ note: text, flags: ["chase-note"] });
  });

  test("any other freeform note -> note-other", () => {
    expect(classifyNote("จ่ายไม่เกิน 31/7/69")).toEqual({ note: "จ่ายไม่เกิน 31/7/69", flags: ["note-other"] });
  });
});

describe("evaluateWorkbookRow", () => {
  function fakeRow(overrides: Partial<Record<number, unknown>>): unknown[] {
    // Column layout per ap-seed.ts's header comment. Defaults describe a
    // clean, open, unpaid Booking.com row with no VAT/WHT/discount/due date.
    const row: unknown[] = new Array(16).fill("");
    row[0] = "Booking.com"; // creditor
    row[1] = "ค่าคอมมิชชั่นทดสอบ"; // item
    row[2] = 1000; // amount
    row[11] = 1000; // outstanding
    for (const [k, v] of Object.entries(overrides)) row[Number(k)] = v;
    return row;
  }

  test("a blank spacer row is excluded", () => {
    expect(evaluateWorkbookRow(new Array(16).fill(""), 99)).toEqual({ kind: "excluded" });
  });

  test("a row already marked paid is excluded", () => {
    expect(evaluateWorkbookRow(fakeRow({ 15: "จ่ายแล้ว 1/1/2569" }), 5)).toEqual({ kind: "excluded" });
  });

  test("a row with zero outstanding is excluded", () => {
    expect(evaluateWorkbookRow(fakeRow({ 11: 0 }), 5)).toEqual({ kind: "excluded" });
  });

  test("a row with no resolvable category is skipped with a reason", () => {
    const result = evaluateWorkbookRow(fakeRow({ 0: "ร้านทั่วไป" }), 40);
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") {
      expect(result.row.reason).toMatch(/no category mapping/);
      expect(result.row.sourceRow).toBe(40);
    }
  });

  test("a row with an unexplained L/amount discrepancy is skipped with a reason", () => {
    const result = evaluateWorkbookRow(fakeRow({ 11: 955 }), 25);
    expect(result.kind).toBe("skip");
    if (result.kind === "skip") expect(result.row.reason).toMatch(/does not match/);
  });

  test("a clean, open, mapped row is seeded with correct satang conversion and clean flag", () => {
    const result = evaluateWorkbookRow(fakeRow({}), 16);
    expect(result.kind).toBe("seed");
    if (result.kind === "seed") {
      const row: SeedRow = result.row;
      expect(row.creditor).toBe("Booking.com");
      expect(row.amountSatang).toBe(100_000);
      expect(row.vatSatang).toBeNull();
      expect(row.whtSatang).toBeNull();
      expect(row.discountSatang).toBe(0);
      expect(row.dueDate).toBeNull();
      expect(row.categoryCode).toBe("commission-booking");
      expect(row.flags).toEqual(["clean"]);
    }
  });

  test("an unpaid row carrying a เดือนN note is seeded with that flag and note preserved", () => {
    const result = evaluateWorkbookRow(fakeRow({ 15: "เดือน10" }), 18);
    expect(result.kind).toBe("seed");
    if (result.kind === "seed") {
      expect(result.row.note).toBe("เดือน10");
      expect(result.row.flags).toEqual(["เดือนX-marked"]);
    }
  });

  test("a withholding-tax-adjusted row still seeds with the correct satang amounts", () => {
    const result = evaluateWorkbookRow(fakeRow({ 0: "หจก.บุญดี 99", 4: 30, 11: 970 }), 40);
    expect(result.kind).toBe("seed");
    if (result.kind === "seed") {
      expect(result.row.whtSatang).toBe(3_000);
      expect(result.row.categoryCode).toBe("housekeeping");
    }
  });
});

describe("toApRowInput", () => {
  test("projects a SeedRow down to exactly the store's ApRowInput fields", () => {
    const row: SeedRow = {
      sourceRow: 16,
      creditor: "Booking.com",
      item: "ทดสอบ",
      amountSatang: 100_000,
      vatSatang: null,
      whtSatang: null,
      discountSatang: 0,
      dueDate: null,
      entity: "HF",
      categoryCode: "commission-booking",
      note: "",
      flags: ["clean"],
    };
    expect(toApRowInput(row)).toEqual({
      creditor: "Booking.com",
      item: "ทดสอบ",
      amountSatang: 100_000,
      vatSatang: null,
      whtSatang: null,
      discountSatang: 0,
      dueDate: null,
      entity: "HF",
      categoryCode: "commission-booking",
      note: "",
    });
  });
});
