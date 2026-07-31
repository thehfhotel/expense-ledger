// bun:sqlite-backed AP register store tests. Each test gets its own temp DB
// file (AP_DB_PATH env var + _resetForTests()) so tests never share state or
// race on a shared file. The lazy-open contract itself (no file touched
// until the store is actually used) is verified in server.test.ts, which
// drives this through fetchHandler/GET /healthz rather than importing this
// module directly — see that file's "AP store lazy-open" describe block.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AP_PHOTO_MAX_BYTES,
  ApRowHasPaymentsError,
  _apPhotoFilePathForTests,
  _getDbForTests,
  _migrateCategoryCodeNullableForTests,
  _resetForTests,
  addApPayment,
  computeApSummary,
  contentTypeForApPhotoExt,
  createApPhoto,
  createApRow,
  deleteApPayment,
  deleteApPhoto,
  deleteApPhotoFile,
  deleteApPhotoRowDir,
  deleteApRow,
  extForApPhotoFilename,
  getApPayment,
  getApPhotoRecord,
  getApRow,
  listApRows,
  listCreditorHints,
  updateApRow,
} from "./apStore.ts";
import { todayBangkok } from "../shared/date.ts";
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

describe("settled with zero payments (H3 fix — credit-note case)", () => {
  test("a discount equal to the gross amount settles the row at creation with a non-null settledAt", () => {
    const id = createApRow(baseRowInput({ amountSatang: 5_000, vatSatang: null, whtSatang: null, discountSatang: 5_000 }), "clerk@thehfhotel.org");
    const row = getApRow(id)!;
    expect(row.outstandingSatang).toBe(0);
    expect(row.payments.length).toBe(0);
    expect(row.settledAt).not.toBeNull();
    // Falls back to the row's own Bangkok filing date (today, since this
    // test just created it) — never the null that used to crash
    // ApPage.tsx's isoToBuddhist(row.settledAt!) render (H3).
    expect(row.settledAt).toBe(todayBangkok());
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

  test("mode=month falls back to the FILING month when the due date is blank", () => {
    const id = createApRow(baseRowInput({ creditor: "No Due Date Co", dueDate: null }), "clerk@thehfhotel.org");
    const rows = listApRows({ mode: "month", month: todayBangkok().slice(0, 7) });
    expect(rows.map((r) => r.id)).toContain(id);
  });

  test("M1 fix: the month fallback uses the Bangkok filed_date, not created_at's UTC calendar date", () => {
    // Simulates a row created 00:00-07:00 Bangkok on the 1st: created_at (a
    // UTC timestamp) still reads the LAST day of the PREVIOUS month at that
    // moment, but filed_date (computed from todayBangkok() at insert time)
    // correctly reads the new month. Manipulated directly via raw SQL —
    // apStore's public API has no seam to fake "now" — to prove the filter
    // reads filed_date and NOT created_at.slice(0, 7).
    const id = createApRow(baseRowInput({ creditor: "Edge Case Co", dueDate: null }), "clerk@thehfhotel.org");
    const db = new Database(process.env.AP_DB_PATH!);
    db.query("UPDATE ap_row SET created_at = ?, filed_date = ? WHERE id = ?").run(
      "2026-07-31T20:00:00.000Z", // UTC — still July 31 in UTC
      "2026-08-01", // but already Aug 1 in Bangkok (UTC+7)
      id,
    );
    db.close();
    _resetForTests(); // re-open so the next call sees the raw UPDATE above

    const augustRows = listApRows({ mode: "month", month: "2026-08" });
    expect(augustRows.map((r) => r.id)).toContain(id);

    const julyRows = listApRows({ mode: "month", month: "2026-07" });
    expect(julyRows.map((r) => r.id)).not.toContain(id);
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

describe("RULING 1 (2026-07): nullable categoryCode", () => {
  test("createApRow accepts categoryCode: null", () => {
    const id = createApRow(baseRowInput({ categoryCode: null }), "clerk@thehfhotel.org");
    const row = getApRow(id)!;
    expect(row.categoryCode).toBeNull();
  });

  test("updateApRow can clear an existing categoryCode to null", () => {
    const id = createApRow(baseRowInput({ categoryCode: "commission-booking" }), "clerk@thehfhotel.org");
    updateApRow(id, baseRowInput({ categoryCode: null }));
    expect(getApRow(id)!.categoryCode).toBeNull();
  });

  test("addApPayment with a categoryCodeToPersist atomically sets the row's category alongside the payment insert", () => {
    const id = createApRow(baseRowInput({ categoryCode: null, amountSatang: 10_000 }), "clerk@thehfhotel.org");
    addApPayment(
      id,
      {
        date: "2026-07-05",
        amountSatang: 4_000,
        paymentMethod: "cash",
        kind: "deposit",
        installmentNumber: null,
        payerEmail: "clerk@thehfhotel.org",
        transactionId: "tx-cat-1",
      },
      "commission-booking",
    );
    const row = getApRow(id)!;
    expect(row.categoryCode).toBe("commission-booking");
    expect(row.outstandingSatang).toBe(6_000);
    expect(row.payments.length).toBe(1);
  });

  test("addApPayment with no categoryCodeToPersist (default) never touches an existing category", () => {
    const id = createApRow(baseRowInput({ categoryCode: "housekeeping", amountSatang: 10_000 }), "clerk@thehfhotel.org");
    addApPayment(id, {
      date: "2026-07-05",
      amountSatang: 4_000,
      paymentMethod: "cash",
      kind: "deposit",
      installmentNumber: null,
      payerEmail: "clerk@thehfhotel.org",
      transactionId: "tx-cat-2",
    });
    expect(getApRow(id)!.categoryCode).toBe("housekeeping");
  });

  test("migrateCategoryCodeNullable: a pre-ruling volume with category_code NOT NULL is upgraded transparently, preserving existing rows", () => {
    // Simulate a volume created before this ruling: build the OLD schema by
    // hand (category_code TEXT NOT NULL) with one pre-existing row, close it,
    // then let apStore's normal lazy-open path (which runs the migration on
    // every open) pick it up.
    _resetForTests();
    const oldDb = new Database(process.env.AP_DB_PATH!, { create: true });
    oldDb.exec(`
      CREATE TABLE ap_row (
        id TEXT PRIMARY KEY,
        creditor TEXT NOT NULL,
        item TEXT NOT NULL,
        amount_satang INTEGER NOT NULL,
        vat_satang INTEGER,
        wht_satang INTEGER,
        discount_satang INTEGER NOT NULL DEFAULT 0,
        due_date TEXT,
        entity TEXT NOT NULL DEFAULT '',
        category_code TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        filed_date TEXT NOT NULL
      );
    `);
    oldDb.exec(`
      CREATE TABLE ap_payment (
        id TEXT PRIMARY KEY,
        row_id TEXT NOT NULL REFERENCES ap_row(id) ON DELETE CASCADE,
        date TEXT NOT NULL,
        amount_satang INTEGER NOT NULL,
        payment_method TEXT NOT NULL,
        kind TEXT NOT NULL,
        installment_number INTEGER,
        payer_email TEXT NOT NULL,
        transaction_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    oldDb
      .query(
        `INSERT INTO ap_row
          (id, creditor, item, amount_satang, vat_satang, wht_satang, discount_satang, due_date, entity, category_code, note, created_at, created_by, filed_date)
         VALUES ('pre-existing-1', 'Booking.com', 'ค่าคอมมิชชั่น', 10000, NULL, NULL, 0, NULL, 'HF', 'commission-booking', '', '2026-07-01T00:00:00.000Z', 'seed:workbook-2026-07', '2026-07-01')`,
      )
      .run();
    oldDb.close();

    // The pre-existing table's column really is NOT NULL before migration.
    const before = new Database(process.env.AP_DB_PATH!, { readonly: true });
    const beforeInfo = before.query("PRAGMA table_info(ap_row)").all() as { name: string; notnull: number }[];
    before.close();
    expect(beforeInfo.find((c) => c.name === "category_code")?.notnull).toBe(1);

    // Any store call opens the db (running the migration first).
    const preExisting = getApRow("pre-existing-1")!;
    expect(preExisting.creditor).toBe("Booking.com");
    expect(preExisting.categoryCode).toBe("commission-booking");

    // The column is now nullable, and a fresh null-category row works.
    const after = new Database(process.env.AP_DB_PATH!, { readonly: true });
    const afterInfo = after.query("PRAGMA table_info(ap_row)").all() as { name: string; notnull: number }[];
    after.close();
    expect(afterInfo.find((c) => c.name === "category_code")?.notnull).toBe(0);

    const newId = createApRow(baseRowInput({ categoryCode: null }), "clerk@thehfhotel.org");
    expect(getApRow(newId)!.categoryCode).toBeNull();
    // The pre-existing row survived the table rebuild untouched.
    expect(getApRow("pre-existing-1")!.creditor).toBe("Booking.com");
  });
});

describe("M1 fix: busy_timeout", () => {
  test("openDb sets a 5s busy_timeout, so a second process racing this one's writes waits instead of failing immediately", () => {
    createApRow(baseRowInput(), "clerk@thehfhotel.org"); // forces the lazy open
    const pragma = _getDbForTests().query("PRAGMA busy_timeout").get() as { timeout: number };
    expect(pragma.timeout).toBe(5000);
  });
});

describe("L3 fix: a throwing migration restores the pragma and doesn't leak the handle", () => {
  /** Builds the pre-ruling schema (category_code NOT NULL) so the migration
   * runs on next touch, then pre-creates the migration's OWN scratch table
   * under an incompatible shape so its `CREATE TABLE
   * ap_row__migrating_nullable_category` step throws partway through the
   * transaction — simulating ANY mid-migration failure without needing an
   * injection seam into the migration's SQL itself. */
  function seedPreRulingSchemaWithScratchTableCollision(): void {
    const seedDb = new Database(process.env.AP_DB_PATH!, { create: true });
    seedDb.exec(`
      CREATE TABLE ap_row (
        id TEXT PRIMARY KEY,
        creditor TEXT NOT NULL,
        item TEXT NOT NULL,
        amount_satang INTEGER NOT NULL,
        vat_satang INTEGER,
        wht_satang INTEGER,
        discount_satang INTEGER NOT NULL DEFAULT 0,
        due_date TEXT,
        entity TEXT NOT NULL DEFAULT '',
        category_code TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        filed_date TEXT NOT NULL
      );
    `);
    seedDb.exec("CREATE TABLE ap_row__migrating_nullable_category (bogus INTEGER);");
    seedDb.close();
  }

  test("migrateCategoryCodeNullable's try/finally restores PRAGMA foreign_keys = ON even when the migration throws", () => {
    _resetForTests();
    seedPreRulingSchemaWithScratchTableCollision();

    const db = new Database(process.env.AP_DB_PATH!);
    expect(() => _migrateCategoryCodeNullableForTests(db)).toThrow();

    const fk = db.query("PRAGMA foreign_keys").get() as { foreign_keys: number };
    expect(fk.foreign_keys).toBe(1);
    db.close();
  });

  test("openDb closes the handle rather than leaking it when the migration fails", () => {
    _resetForTests();
    seedPreRulingSchemaWithScratchTableCollision();

    const closeSpy = spyOn(Database.prototype, "close");
    try {
      expect(() => getApRow("anything")).toThrow();
      expect(closeSpy).toHaveBeenCalled();
    } finally {
      closeSpy.mockRestore();
    }
  });
});

describe("AP row photos", () => {
  function jpegBlob(bytes = 16): Blob {
    return new Blob([new Uint8Array(bytes)], { type: "image/jpeg" });
  }

  describe("filename -> ext allow-list (BLOCKER 1 / RULING 3)", () => {
    test("accepts jpg/jpeg/png/webp case-insensitively, mapped to a canonical lowercase ext", () => {
      // BLOCKER 1: DCF cameras and Windows scanners routinely emit uppercase
      // extensions — gating on the FILENAME (never Bun's file.type) must
      // accept these exactly like their lowercase equivalents.
      expect(extForApPhotoFilename("bill.jpg")).toBe("jpg");
      expect(extForApPhotoFilename("bill.jpeg")).toBe("jpg");
      expect(extForApPhotoFilename("bill.png")).toBe("png");
      expect(extForApPhotoFilename("bill.webp")).toBe("webp");
      expect(extForApPhotoFilename("IMG_0002.JPG")).toBe("jpg");
      expect(extForApPhotoFilename("scan.JPEG")).toBe("jpg");
      expect(extForApPhotoFilename("DSC_0001.PNG")).toBe("png");
      expect(extForApPhotoFilename("photo.WEBP")).toBe("webp");
    });

    test("rejects an extensionless filename and anything off the allow-list", () => {
      expect(extForApPhotoFilename("noext")).toBeNull();
      expect(extForApPhotoFilename("trailing.")).toBeNull();
      expect(extForApPhotoFilename("bill.pdf")).toBeNull();
      expect(extForApPhotoFilename("bill.txt")).toBeNull();
      // RULING 3 (2026-07, owner decision): HEIC dropped entirely.
      expect(extForApPhotoFilename("bill.heic")).toBeNull();
      expect(extForApPhotoFilename("bill.HEIC")).toBeNull();
    });

    test("contentTypeForApPhotoExt is the inverse for every allowed ext; HEIC no longer maps to anything", () => {
      expect(contentTypeForApPhotoExt("jpg")).toBe("image/jpeg");
      expect(contentTypeForApPhotoExt("png")).toBe("image/png");
      expect(contentTypeForApPhotoExt("webp")).toBe("image/webp");
      expect(contentTypeForApPhotoExt("heic")).toBe("application/octet-stream");
    });

    test("an unknown ext falls back to a generic binary content-type rather than throwing", () => {
      expect(contentTypeForApPhotoExt("bogus")).toBe("application/octet-stream");
    });
  });

  test("createApPhoto writes the file to disk AND inserts a DB row a subsequent lookup finds", async () => {
    const rowId = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    const record = await createApPhoto(rowId, {
      ext: "jpg",
      size: 16,
      createdBy: "clerk@thehfhotel.org",
      data: jpegBlob(),
    });

    expect(record.rowId).toBe(rowId);
    expect(existsSync(_apPhotoFilePathForTests(rowId, record.id, "jpg"))).toBe(true);

    const found = getApPhotoRecord(record.id);
    expect(found).not.toBeNull();
    expect(found!.ext).toBe("jpg");
    expect(found!.size).toBe(16);
    expect(found!.createdBy).toBe("clerk@thehfhotel.org");
  });

  test("the row's photos come back embedded on GET, oldest first", async () => {
    const rowId = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    const first = await createApPhoto(rowId, { ext: "jpg", size: 1, createdBy: "a@thehfhotel.org", data: jpegBlob(1) });
    const second = await createApPhoto(rowId, { ext: "png", size: 1, createdBy: "a@thehfhotel.org", data: jpegBlob(1) });

    const row = getApRow(rowId)!;
    expect(row.photos.map((p) => p.id)).toEqual([first.id, second.id]);
    expect(row.photos[0]!.url).toBe(`/api/ap/photos/${first.id}`);
  });

  test("getApPhotoRecord returns null for a bogus/nonexistent id — the ONLY lookup path GET ever uses", () => {
    expect(getApPhotoRecord("does-not-exist")).toBeNull();
    // Even a traversal-shaped id is just a DB key here, never a path — see
    // apStore.ts's "AP row photos" doc comment.
    expect(getApPhotoRecord("../../../../etc/passwd")).toBeNull();
  });

  test("deleteApPhoto removes exactly the (rowId, photoId) pair's DB row and returns it, but leaves the file untouched", async () => {
    const rowId = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    const record = await createApPhoto(rowId, { ext: "jpg", size: 1, createdBy: "a@thehfhotel.org", data: jpegBlob(1) });

    const deleted = deleteApPhoto(rowId, record.id);
    expect(deleted?.id).toBe(record.id);
    expect(getApPhotoRecord(record.id)).toBeNull();
    // apStore.deleteApPhoto is DB-only by design — the caller
    // (src/server/server.ts) removes the file via deleteApPhotoFile.
    expect(existsSync(_apPhotoFilePathForTests(rowId, record.id, "jpg"))).toBe(true);
  });

  test("deleteApPhoto returns null for the wrong row scoping (same photo id, different row)", async () => {
    const rowId = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    const otherRowId = createApRow(baseRowInput({ creditor: "Other Co" }), "clerk@thehfhotel.org");
    const record = await createApPhoto(rowId, { ext: "jpg", size: 1, createdBy: "a@thehfhotel.org", data: jpegBlob(1) });

    expect(deleteApPhoto(otherRowId, record.id)).toBeNull();
    expect(getApPhotoRecord(record.id)).not.toBeNull();
  });

  test("deleteApPhotoFile removes the file from disk, and is a no-op (never throws) when it's already gone", async () => {
    const rowId = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    const record = await createApPhoto(rowId, { ext: "jpg", size: 1, createdBy: "a@thehfhotel.org", data: jpegBlob(1) });
    const path = _apPhotoFilePathForTests(rowId, record.id, "jpg");
    expect(existsSync(path)).toBe(true);

    await deleteApPhotoFile(record);
    expect(existsSync(path)).toBe(false);

    // Second call: file already gone — must not throw.
    await expect(deleteApPhotoFile(record)).resolves.toBeUndefined();
  });

  test("deleteApPhotoRowDir removes every photo file under a row, recursively, and cascades the DB rows via the ap_row foreign key", async () => {
    const rowId = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    const a = await createApPhoto(rowId, { ext: "jpg", size: 1, createdBy: "a@thehfhotel.org", data: jpegBlob(1) });
    const b = await createApPhoto(rowId, { ext: "png", size: 1, createdBy: "a@thehfhotel.org", data: jpegBlob(1) });

    deleteApRow(rowId); // zero payments — allowed; cascades ap_photo DB rows
    expect(getApPhotoRecord(a.id)).toBeNull();
    expect(getApPhotoRecord(b.id)).toBeNull();
    expect(existsSync(_apPhotoFilePathForTests(rowId, a.id, "jpg"))).toBe(true); // files: caller's job
    expect(existsSync(_apPhotoFilePathForTests(rowId, b.id, "png"))).toBe(true);

    await deleteApPhotoRowDir(rowId);
    expect(existsSync(_apPhotoFilePathForTests(rowId, a.id, "jpg"))).toBe(false);
    expect(existsSync(_apPhotoFilePathForTests(rowId, b.id, "png"))).toBe(false);
  });

  test("deleteApPhotoRowDir on a row that never had any photos is a silent no-op", async () => {
    const rowId = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    await expect(deleteApPhotoRowDir(rowId)).resolves.toBeUndefined();
  });

  test("createApPhoto compensates by deleting the just-written file when the DB insert fails (row deleted concurrently)", async () => {
    const rowId = createApRow(baseRowInput(), "clerk@thehfhotel.org");
    deleteApRow(rowId); // row now gone -> the FK insert below must fail

    await expect(
      createApPhoto(rowId, { ext: "jpg", size: 1, createdBy: "a@thehfhotel.org", data: jpegBlob(1) }),
    ).rejects.toThrow();

    // No orphan file left behind after the compensating cleanup.
    const dir = join(tmpDir, "ap-photos", rowId);
    expect(existsSync(dir) ? readdirSync(dir).length : 0).toBe(0);
  });

  test("AP_PHOTO_MAX_BYTES is 10 MiB", () => {
    expect(AP_PHOTO_MAX_BYTES).toBe(10 * 1024 * 1024);
  });
});
