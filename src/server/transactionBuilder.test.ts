import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_CATEGORY_CASH,
  ACCOUNT_CATEGORY_CHECKING,
  AccountNotMappedError,
  BANGKOK_UTC_OFFSET_MINUTES,
  CATEGORY_TYPE_EXPENSE,
  CategoryNotMappedError,
  TRANSACTION_TYPE_EXPENSE,
  buildEngineTransactionPayload,
  buildTransactionUnixTimeSeconds,
  deriveDateFromEngineTime,
  resolveAccountEngineId,
  resolveCategoryEngineId,
} from "./transactionBuilder.ts";

describe("category id resolution", () => {
  const map = new Map([
    ["salary", "101"],
    ["electricity-ville", "112"],
  ]);

  test("resolves a mapped code to its engine id", () => {
    expect(resolveCategoryEngineId(map, "salary")).toBe("101");
    expect(resolveCategoryEngineId(map, "electricity-ville")).toBe("112");
  });

  test("throws CategoryNotMappedError for an unmapped code, never silently mis-files", () => {
    expect(() => resolveCategoryEngineId(map, "unseeded-code")).toThrow(CategoryNotMappedError);
  });

  test("the two category enums are distinct: category type (2) is not transaction type (3)", () => {
    // Guards against reusing the wrong enum when querying the engine's
    // category list — see transactionBuilder.ts's file-level note.
    expect(CATEGORY_TYPE_EXPENSE).toBe(2);
    expect(TRANSACTION_TYPE_EXPENSE).toBe(3);
    expect(CATEGORY_TYPE_EXPENSE).not.toBe(TRANSACTION_TYPE_EXPENSE);
  });
});

describe("account id resolution", () => {
  const map = new Map([
    ["cash", "1"],
    ["bank", "2"],
  ]);

  test("resolves cash and bank independently", () => {
    expect(resolveAccountEngineId(map, "cash")).toBe("1");
    expect(resolveAccountEngineId(map, "bank")).toBe("2");
  });

  test("throws AccountNotMappedError when a payment method has no account", () => {
    expect(() => resolveAccountEngineId(new Map(), "cash")).toThrow(AccountNotMappedError);
  });

  test("the engine's AccountCategory enum values are distinct (cash=1, checking=2)", () => {
    expect(ACCOUNT_CATEGORY_CASH).toBe(1);
    expect(ACCOUNT_CATEGORY_CHECKING).toBe(2);
  });
});

describe("time construction — buildTransactionUnixTimeSeconds / deriveDateFromEngineTime", () => {
  test("combines the given date with `now`'s Bangkok time-of-day", () => {
    // 2026-07-15 10:30:00 UTC = 2026-07-15 17:30:00 Bangkok (UTC+7).
    const now = new Date("2026-07-15T10:30:00.000Z");
    const seconds = buildTransactionUnixTimeSeconds("2026-07-20", now);
    // Same wall-clock time-of-day (17:30:00), projected onto 2026-07-20 in
    // Bangkok -> 2026-07-20T10:30:00Z.
    expect(seconds).toBe(Date.UTC(2026, 6, 20, 10, 30, 0) / 1000);
  });

  test("round-trips back to the same calendar date via deriveDateFromEngineTime", () => {
    const now = new Date("2026-01-05T23:50:00.000Z"); // late UTC evening
    const seconds = buildTransactionUnixTimeSeconds("2026-01-05", now);
    expect(deriveDateFromEngineTime(seconds)).toBe("2026-01-05");
  });

  test("round-trips correctly across a Bangkok midnight boundary", () => {
    // 2026-03-10 17:15:00 UTC = 2026-03-11 00:15:00 Bangkok — already past
    // midnight in Bangkok even though `now` is still 2026-03-10 in UTC.
    const now = new Date("2026-03-10T17:15:00.000Z");
    const seconds = buildTransactionUnixTimeSeconds("2026-03-11", now);
    expect(deriveDateFromEngineTime(seconds)).toBe("2026-03-11");
  });

  test("later same-day submissions produce a strictly later `time`, preserving insertion order", () => {
    const earlier = buildTransactionUnixTimeSeconds("2026-07-15", new Date("2026-07-15T03:00:00.000Z"));
    const later = buildTransactionUnixTimeSeconds("2026-07-15", new Date("2026-07-15T03:05:00.000Z"));
    expect(later).toBeGreaterThan(earlier);
  });
});

describe("buildEngineTransactionPayload", () => {
  const now = new Date("2026-07-15T05:00:00.000Z");

  test("amount unit conversion: amountSatang passes through as sourceAmount unchanged (THB minor unit = satang)", () => {
    const payload = buildEngineTransactionPayload({
      amountSatang: 298_380,
      categoryEngineId: "101",
      sourceAccountEngineId: "1",
      comment: "ค่าไฟ สายชล มี.ค. 69\n[hf:by=winut.hf@gmail.com]",
      dateIso: "2026-07-15",
      now,
    });
    expect(payload.sourceAmount).toBe(298_380);
  });

  test("a single satang and a very large amount both pass through exactly (no float drift)", () => {
    expect(
      buildEngineTransactionPayload({
        amountSatang: 1,
        categoryEngineId: "1",
        sourceAccountEngineId: "1",
        comment: "x",
        dateIso: "2026-07-15",
        now,
      }).sourceAmount,
    ).toBe(1);
    expect(
      buildEngineTransactionPayload({
        amountSatang: 99_999_999_999,
        categoryEngineId: "1",
        sourceAccountEngineId: "1",
        comment: "x",
        dateIso: "2026-07-15",
        now,
      }).sourceAmount,
    ).toBe(99_999_999_999);
  });

  test("sets the fixed Bangkok utcOffset and the expense transaction type", () => {
    const payload = buildEngineTransactionPayload({
      amountSatang: 100,
      categoryEngineId: "1",
      sourceAccountEngineId: "1",
      comment: "x",
      dateIso: "2026-07-15",
      now,
    });
    expect(payload.utcOffset).toBe(BANGKOK_UTC_OFFSET_MINUTES);
    expect(payload.type).toBe(TRANSACTION_TYPE_EXPENSE);
  });

  test("resolves categoryId/sourceAccountId from the already-resolved engine ids given", () => {
    const payload = buildEngineTransactionPayload({
      amountSatang: 100,
      categoryEngineId: "112",
      sourceAccountEngineId: "2",
      comment: "x",
      dateIso: "2026-07-15",
      now,
    });
    expect(payload.categoryId).toBe("112");
    expect(payload.sourceAccountId).toBe("2");
  });

  test("never sends tags (v1 sends none) and defaults pictureIds to an empty array", () => {
    const payload = buildEngineTransactionPayload({
      amountSatang: 100,
      categoryEngineId: "1",
      sourceAccountEngineId: "1",
      comment: "x",
      dateIso: "2026-07-15",
      now,
    });
    expect(payload.tagIds).toEqual([]);
    expect(payload.pictureIds).toEqual([]);
  });

  test("passes through explicit pictureIds when given", () => {
    const payload = buildEngineTransactionPayload({
      amountSatang: 100,
      categoryEngineId: "1",
      sourceAccountEngineId: "1",
      comment: "x",
      dateIso: "2026-07-15",
      now,
      pictureIds: ["55", "56"],
    });
    expect(payload.pictureIds).toEqual(["55", "56"]);
  });
});
