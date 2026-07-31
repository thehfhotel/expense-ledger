// bun:sqlite-backed AP register store tests. Each test gets its own temp DB
// file (AP_DB_PATH env var + _resetForTests()) so tests never share state or
// race on a shared file. The lazy-open contract itself (no file touched
// until the store is actually used) is verified in server.test.ts, which
// drives this through fetchHandler/GET /healthz rather than importing this
// module directly — see that file's "AP store lazy-open" describe block.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ApRowHasPaymentsError,
  _resetForTests,
  addApPayment,
  computeApSummary,
  createApRow,
  deleteApPayment,
  deleteApRow,
  getApPayment,
  getApRow,
  listApRows,
  listCreditorHints,
  updateApRow,
} from "./apStore.ts";
import type { ApRowInput } from "../shared/apTypes.ts";

let tmpDir: string;

function baseRowInput(overrides: Partial<ApRowInput> = {}): ApRowInput {
  return {
    creditor: "Booking.com",
    item: "ค่าคอมมิชชั่น ก.ค. 69",
    amountSatang: 10_000,
    vatSatang: null,
    whtSatang: null,
    discountSatang: 0,
    dueDate: "2026-07-20",
    entity: "HF",
    categoryCode: "commission-booking",
    note: "",
    ...overrides,
  };
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "ap-store-test-"));
  process.env.AP_DB_PATH = join(tmpDir, "ap.db");
  _resetForTests();
});

afterEach(() => {
  _resetForTests();
  delete process.env.AP_DB_PATH;
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("createApRow / getApRow round trip", () => {
  test("stores and reads back every field, with gross/outstanding computed", () => {
    const id = createApRow(baseRowInput({ vatSatang: 700, whtSatang: 300 }), "clerk@thehfhotel.org");
    const row = getApRow(id);
    expect(row).not.toBeNull();
    expect(row!.creditor).toBe("Booking.com");
    expect(row!.createdBy).toBe("clerk@thehfhotel.org");
    expect(row!.grossSatang).toBe(10_000 + 700 - 300);
    expect(row!.outstandingSatang).toBe(10_400);
    expect(row!.payments).toEqual([]);
    expect(row!.settledAt).toBeNull();
  });

  test("returns null for an unknown id", () => {
    expect(getApRow("does-not-exist")).toBeNull();
  });
});

describe("updateApRow", () => {
  test("overwrites every editable field", () => {
    const id = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    updateApRow(id, baseRowInput({ creditor: "หจก.บุญดี", amountSatang: 20_000, note: "แก้ไขแล้ว" }));
    const row = getApRow(id)!;
    expect(row.creditor).toBe("หจก.บุญดี");
    expect(row.amountSatang).toBe(20_000);
    expect(row.note).toBe("แก้ไขแล้ว");
  });
});

describe("payments and settlement", () => {
  test("adding a payment reduces outstanding and is reflected on the row", () => {
    const id = createApRow(baseRowInput({ amountSatang: 10_000 }), "clerk@thehfhotel.org");
    addApPayment(id, {
      date: "2026-07-05",
      amountSatang: 4_000,
      paymentMethod: "cash",
      kind: "deposit",
      installmentNumber: null,
      payerEmail: "clerk@thehfhotel.org",
      transactionId: "tx-1",
    });
    const row = getApRow(id)!;
    expect(row.outstandingSatang).toBe(6_000);
    expect(row.payments.length).toBe(1);
    expect(row.settledAt).toBeNull();
  });

  test("a fully-paying payment sets settledAt to that payment's date", () => {
    const id = createApRow(baseRowInput({ amountSatang: 10_000 }), "clerk@thehfhotel.org");
    addApPayment(id, {
      date: "2026-07-21",
      amountSatang: 10_000,
      paymentMethod: "bank",
      kind: "full",
      installmentNumber: null,
      payerEmail: "clerk@thehfhotel.org",
      transactionId: "tx-2",
    });
    const row = getApRow(id)!;
    expect(row.outstandingSatang).toBe(0);
    expect(row.settledAt).toBe("2026-07-21");
  });

  test("getApPayment / deleteApPayment round trip", () => {
    const id = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    const paymentId = addApPayment(id, {
      date: "2026-07-05",
      amountSatang: 1_000,
      paymentMethod: "cash",
      kind: "deposit",
      installmentNumber: null,
      payerEmail: "clerk@thehfhotel.org",
      transactionId: "tx-3",
    });
    expect(getApPayment(id, paymentId)?.transactionId).toBe("tx-3");
    deleteApPayment(id, paymentId);
    expect(getApPayment(id, paymentId)).toBeNull();
    expect(getApRow(id)!.outstandingSatang).toBe(10_000);
  });

  test("getApPayment scopes to the given rowId — a payment id under a different row is not found", () => {
    const rowA = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    const rowB = createApRow(baseRowInput({ creditor: "การไฟฟ้า" }), "clerk@thehfhotel.org");
    const paymentId = addApPayment(rowA, {
      date: "2026-07-05",
      amountSatang: 1_000,
      paymentMethod: "cash",
      kind: "deposit",
      installmentNumber: null,
      payerEmail: "clerk@thehfhotel.org",
      transactionId: "tx-4",
    });
    expect(getApPayment(rowB, paymentId)).toBeNull();
  });
});

describe("deleteApRow — void rule", () => {
  test("deletes a row with zero payments", () => {
    const id = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    deleteApRow(id);
    expect(getApRow(id)).toBeNull();
  });

  test("throws ApRowHasPaymentsError for a row with >= 1 payment, and does not delete it", () => {
    const id = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    addApPayment(id, {
      date: "2026-07-05",
      amountSatang: 1_000,
      paymentMethod: "cash",
      kind: "deposit",
      installmentNumber: null,
      payerEmail: "clerk@thehfhotel.org",
      transactionId: "tx-5",
    });
    expect(() => deleteApRow(id)).toThrow(ApRowHasPaymentsError);
    expect(getApRow(id)).not.toBeNull();
  });
});

describe("listApRows filters", () => {
  test("mode=open returns only rows with outstanding > 0", () => {
    const openId = createApRow(baseRowInput({ creditor: "Open Co" }), "clerk@thehfhotel.org");
    const settledId = createApRow(baseRowInput({ creditor: "Settled Co", amountSatang: 5_000 }), "clerk@thehfhotel.org");
    addApPayment(settledId, {
      date: "2026-07-05",
      amountSatang: 5_000,
      paymentMethod: "cash",
      kind: "full",
      installmentNumber: null,
      payerEmail: "clerk@thehfhotel.org",
      transactionId: "tx-6",
    });
    const openRows = listApRows({ mode: "open" });
    expect(openRows.map((r) => r.id)).toEqual([openId]);
    expect(openRows.map((r) => r.id)).not.toContain(settledId);
  });

  test("mode=all returns every row regardless of settlement", () => {
    createApRow(baseRowInput({ creditor: "A" }), "clerk@thehfhotel.org");
    createApRow(baseRowInput({ creditor: "B" }), "clerk@thehfhotel.org");
    expect(listApRows({ mode: "all" }).length).toBe(2);
  });

  test("mode=month matches the due date's month", () => {
    const july = createApRow(baseRowInput({ creditor: "July Co", dueDate: "2026-07-20" }), "clerk@thehfhotel.org");
    createApRow(baseRowInput({ creditor: "Aug Co", dueDate: "2026-08-05" }), "clerk@thehfhotel.org");
    const rows = listApRows({ mode: "month", month: "2026-07" });
    expect(rows.map((r) => r.id)).toEqual([july]);
  });

  test("mode=month falls back to the created month when the due date is blank", () => {
    const id = createApRow(baseRowInput({ creditor: "No Due Date Co", dueDate: null }), "clerk@thehfhotel.org");
    const row = getApRow(id)!;
    const createdMonth = row.createdAt.slice(0, 7);
    const rows = listApRows({ mode: "month", month: createdMonth });
    expect(rows.map((r) => r.id)).toContain(id);
  });
});

describe("computeApSummary", () => {
  test("totals outstanding across only open rows and counts overdue ones", () => {
    createApRow(baseRowInput({ creditor: "Overdue Co", amountSatang: 3_000, dueDate: "2020-01-01" }), "clerk@thehfhotel.org");
    createApRow(baseRowInput({ creditor: "Not Due Yet Co", amountSatang: 2_000, dueDate: "2099-01-01" }), "clerk@thehfhotel.org");
    const settledId = createApRow(baseRowInput({ creditor: "Settled Co", amountSatang: 1_000 }), "clerk@thehfhotel.org");
    addApPayment(settledId, {
      date: "2026-07-05",
      amountSatang: 1_000,
      paymentMethod: "cash",
      kind: "full",
      installmentNumber: null,
      payerEmail: "clerk@thehfhotel.org",
      transactionId: "tx-7",
    });
    const summary = computeApSummary("2026-07-15");
    expect(summary.totalOutstandingSatang).toBe(5_000);
    expect(summary.overdueCount).toBe(1);
  });

  test("ignores the active filter — always over the full open set", () => {
    createApRow(baseRowInput({ creditor: "Overdue Co", amountSatang: 3_000, dueDate: "2020-01-01" }), "clerk@thehfhotel.org");
    // listApRows({mode:"month", month: "2019-01"}) would return zero rows,
    // but computeApSummary must not be scoped by any filter/month.
    const summary = computeApSummary("2026-07-15");
    expect(summary.totalOutstandingSatang).toBe(3_000);
  });
});

describe("listCreditorHints", () => {
  test("one hint per distinct creditor, carrying its MOST RECENT row's category/entity", async () => {
    createApRow(baseRowInput({ creditor: "การไฟฟ้า", categoryCode: "other", entity: "HF" }), "clerk@thehfhotel.org");
    // Ensure a strictly later created_at timestamp for the second row under
    // the same creditor.
    await new Promise((resolve) => setTimeout(resolve, 5));
    createApRow(
      baseRowInput({ creditor: "การไฟฟ้า", categoryCode: "electricity-saichon", entity: "SCM" }),
      "clerk@thehfhotel.org",
    );
    const hints = listCreditorHints();
    const matches = hints.filter((h) => h.creditor === "การไฟฟ้า");
    expect(matches.length).toBe(1);
    expect(matches[0]!.categoryCode).toBe("electricity-saichon");
    expect(matches[0]!.entity).toBe("SCM");
  });
});

describe("lazy-open", () => {
  test("the db file is created only once a store function actually runs", () => {
    expect(existsSync(process.env.AP_DB_PATH!)).toBe(false);
    createApRow(baseRowInput(), "clerk@thehfhotel.org");
    expect(existsSync(process.env.AP_DB_PATH!)).toBe(true);
  });
});
