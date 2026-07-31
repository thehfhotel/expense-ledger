// Ported/new coverage for src/shared/money.ts. This file didn't exist before
// the M2 fix (ApRowDrawer.tsx's VAT/WHT/discount fields used to treat an
// unparseable amount as silent 0 rather than a validation error) — these
// tests lock the CONTRACT that fix depends on: parseAmountToSatang must keep
// returning null (never a coerced number) for anything that isn't a valid
// non-negative amount, so a client-side `?? 0` fallback can never again hide
// a clerk's typo.

import { describe, expect, test } from "bun:test";
import { formatSatang, parseAmountToSatang } from "./money.ts";

describe("parseAmountToSatang", () => {
  test("parses a plain integer baht amount", () => {
    expect(parseAmountToSatang("20")).toBe(2_000);
  });

  test("parses a decimal amount with two places", () => {
    expect(parseAmountToSatang("2,983.80")).toBe(298_380);
  });

  test("trims surrounding whitespace", () => {
    expect(parseAmountToSatang(" 490.5 ")).toBe(49_050);
  });

  test("empty input is null", () => {
    expect(parseAmountToSatang("")).toBeNull();
    expect(parseAmountToSatang("   ")).toBeNull();
  });

  // M2 fix's exact regression case: none of these unparseable strings may
  // ever silently coerce to a number — the AP row drawer relies on this null
  // to show a validation error instead of quietly zeroing out a real VAT/
  // WHT/discount figure.
  test("garbage text is null, not a coerced number", () => {
    expect(parseAmountToSatang("abc")).toBeNull();
    expect(parseAmountToSatang("12.345")).toBeNull(); // more than 2 decimal places
    expect(parseAmountToSatang("-5")).toBeNull(); // negative
    expect(parseAmountToSatang("12.")).toBeNull();
    expect(parseAmountToSatang("1e5")).toBeNull();
  });
});

describe("formatSatang", () => {
  test("formats satang as a 2-decimal baht string with thousands separators", () => {
    expect(formatSatang(298_380)).toBe("2,983.80");
  });

  test("formats zero", () => {
    expect(formatSatang(0)).toBe("0.00");
  });
});
