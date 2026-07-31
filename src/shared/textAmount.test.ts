// Ported unchanged from income-ledger's src/shared/textAmount.test.ts — same
// cases, same rationale. See textAmount.ts for the ported implementation.

import { describe, expect, test } from "bun:test";
import { AMOUNT_IN_TEXT_WARNING_TH, looksLikeAmountInText } from "./textAmount.ts";

describe("looksLikeAmountInText — must fire", () => {
  const firing = [
    "(โอนเงิน350)",
    "โอนเงิน 300",
    "ค่าชาร์จ 3% เป็นเงินสด=30 บาท",
    "เงินสด 1,200",
    "ค่าจัดงานวันเกิดลค.ห้อง506(โอนเงิน350)",
    "ค่าเช่าจอดรถ ก8375 (โอนเงิน300)",
    "ค่าห้อง 500 บาท",
    "ค่าอาหารเช้า (สด 120)",
    "มัดจำ เครดิต 2,500",
    "ค่าซักรีด เงินโอน 450",
  ];

  for (const text of firing) {
    test(text, () => {
      expect(looksLikeAmountInText(text)).toBe(true);
    });
  }
});

describe("looksLikeAmountInText — must stay silent", () => {
  const silent = [
    "ค่าอาหารเช้า ห้อง 418",
    "Late checkout R.112",
    "เบาะเสริมR.108 เงินโอน",
    "R.505 อาหารเช้า",
    "ห้อง 418 โอน",
    "R.302 เครดิต",
    "ซื้อผักสด 500",
    "ค่าอาหารสด 1,200",
    "โอน 5",
    "ค่าชาร์จ 3%",
    "โอนแล้วเรียบร้อย ตามรายการห้อง 418",
    "ค่าจอดรถ ทะเบียน กก1234",
    "",
  ];

  for (const text of silent) {
    test(text === "" ? "(empty string)" : text, () => {
      expect(looksLikeAmountInText(text)).toBe(false);
    });
  }
});

test("the warning wording is a single shared Thai string", () => {
  expect(AMOUNT_IN_TEXT_WARNING_TH).toBe("จำนวนเงินอยู่ในข้อความ — กรอกในช่องจำนวนหรือไม่?");
});
