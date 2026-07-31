// isValidIso — H3 fix: a regex-only shape check let impossible dates (day
// 99, month 00, etc.) through, and Date.UTC/the Date constructor silently
// rolled them over into a real, later (or earlier) date, defeating both the
// no-future-date rule and the current-month lock. See date.ts's isValidIso
// doc comment for the round-trip fix.

import { describe, expect, test } from "bun:test";
import { isValidIso } from "./date.ts";

describe("isValidIso — rejects impossible calendar dates", () => {
  const impossible = [
    "2026-06-99", // day out of range for any month — used to roll over to 2026-09-07
    "2026-02-31", // February never has 31 days
    "2026-00-99", // month 00 is not a real month
    "0000-01-01", // year 0 (also a Date.UTC two-digit-year special case)
  ];

  for (const s of impossible) {
    test(`rejects ${s}`, () => {
      expect(isValidIso(s)).toBe(false);
    });
  }
});

describe("isValidIso — accepts valid boundary dates", () => {
  const valid = [
    "2026-02-28", // last day of February in a non-leap year
    "2024-02-29", // leap day
    "2026-07-15", // an ordinary date, for baseline sanity
    "2026-01-31",
    "2026-12-31",
  ];

  for (const s of valid) {
    test(`accepts ${s}`, () => {
      expect(isValidIso(s)).toBe(true);
    });
  }
});

describe("isValidIso — still rejects malformed shapes (the original regex's job)", () => {
  const malformed = ["not-a-date", "2026-7-15", "2026/07/15", "20260715", ""];

  for (const s of malformed) {
    test(`rejects ${JSON.stringify(s)}`, () => {
      expect(isValidIso(s)).toBe(false);
    });
  }
});
