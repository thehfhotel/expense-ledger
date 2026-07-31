// bun:sqlite-backed storage for the AP register ("ค้างจ่าย" — the third
// tab). This is a DOCUMENTED, DELIBERATE exception to this repo's normal
// rule that the server never talks to a database of its own (see CLAUDE.md's
// "AP register storage exception" note) — every baht still lands in the
// ezBookkeeping engine via src/server/engine.ts; this store only holds the
// register bookkeeping (creditor/due-date/payment-history rows) that
// ezBookkeeping has no concept of.
//
// Lazy-open: the database file is opened (and migrated) on first use only —
// never at module import time — so GET /healthz and server boot never touch
// the filesystem for this store. A missing volume directory is created on
// demand, matching the engine-init pattern already used for the engine's own
// storage path (see docker-compose.yml).

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ExpenseCategoryCode } from "../shared/categories.ts";
import { todayBangkok } from "../shared/date.ts";
import {
  computeGross,
  computeOutstanding,
  deriveSettledAt,
  deriveStatus,
  type ApCreditorHint,
  type ApListFilter,
  type ApPayment,
  type ApPaymentKind,
  type ApRow,
  type ApRowInput,
  type ApSummary,
} from "../shared/apTypes.ts";
import type { PaymentMethod } from "../shared/types.ts";

const DEFAULT_DB_PATH = "/app/data/ap.db";

function dbPath(): string {
  return process.env.AP_DB_PATH || DEFAULT_DB_PATH;
}

/** RULING 1 (2026-07) migration: a volume created before this ruling still
 * has `category_code` marked NOT NULL (the CREATE TABLE above only affects a
 * BRAND NEW database — a pre-existing table is untouched by `IF NOT
 * EXISTS`). sqlite has no direct "drop NOT NULL" ALTER; the standard
 * workaround is to rebuild the table under a new name, copy every row
 * across unchanged, then swap names in — see sqlite.org's "Making Other
 * Kinds Of Table Schema Changes". Safe to run on every openDb() call: the
 * PRAGMA table_info check makes it a no-op once migrated (including for
 * every fresh database, whose CREATE TABLE already declares the column
 * nullable). This store has exactly one process ever writing to it
 * (src/server/server.ts's withApWriteLock serializes every AP write within
 * that one process), and this runs before any route can reach the table, so
 * there is no concurrent-writer hazard to guard against here. */
function migrateCategoryCodeNullable(db: Database): void {
  const columns = db.query("PRAGMA table_info(ap_row)").all() as { name: string; notnull: number }[];
  const categoryColumn = columns.find((c) => c.name === "category_code");
  if (!categoryColumn || categoryColumn.notnull === 0) return;

  db.exec("PRAGMA foreign_keys = OFF;");
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE ap_row__migrating_nullable_category (
        id TEXT PRIMARY KEY,
        creditor TEXT NOT NULL,
        item TEXT NOT NULL,
        amount_satang INTEGER NOT NULL,
        vat_satang INTEGER,
        wht_satang INTEGER,
        discount_satang INTEGER NOT NULL DEFAULT 0,
        due_date TEXT,
        entity TEXT NOT NULL DEFAULT '',
        category_code TEXT,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        filed_date TEXT NOT NULL
      );
    `);
    db.exec(`
      INSERT INTO ap_row__migrating_nullable_category
        (id, creditor, item, amount_satang, vat_satang, wht_satang, discount_satang, due_date, entity, category_code, note, created_at, created_by, filed_date)
      SELECT id, creditor, item, amount_satang, vat_satang, wht_satang, discount_satang, due_date, entity, category_code, note, created_at, created_by, filed_date
      FROM ap_row;
    `);
    db.exec("DROP TABLE ap_row;");
    db.exec("ALTER TABLE ap_row__migrating_nullable_category RENAME TO ap_row;");
  });
  migrate();
  db.exec("PRAGMA foreign_keys = ON;");
}

function openDb(path: string): Database {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const db = new Database(path, { create: true });
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS ap_row (
      id TEXT PRIMARY KEY,
      creditor TEXT NOT NULL,
      item TEXT NOT NULL,
      amount_satang INTEGER NOT NULL,
      vat_satang INTEGER,
      wht_satang INTEGER,
      discount_satang INTEGER NOT NULL DEFAULT 0,
      due_date TEXT,
      entity TEXT NOT NULL DEFAULT '',
      -- RULING 1 (2026-07): nullable — a row can be filed before its
      -- category is known (an explicit "ไม่ระบุหมวด" state; see
      -- src/shared/apTypes.ts's ApRow doc comment). A PAYMENT still always
      -- needs a real category; src/server/server.ts's payment route
      -- enforces and persists that. migrateCategoryCodeNullable below
      -- upgrades a pre-ruling volume where this column predates the change
      -- and is still marked NOT NULL.
      category_code TEXT,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      -- M1 fix: the Bangkok CALENDAR date (todayBangkok(), "YYYY-MM-DD") this
      -- row was filed on — used ONLY for the month-fallback filter
      -- (listApRows below) and as deriveSettledAt's zero-payment fallback
      -- (H3 fix). created_at above stays a full UTC ISO timestamp (useful
      -- for same-day insertion-order tiebreaks); slicing THAT for month
      -- filing is exactly the bug (a row created 00:00-07:00 Bangkok on the
      -- 1st has a created_at whose UTC calendar date is still the LAST day
      -- of the previous month, so createdAt.slice(0,7) named the wrong
      -- month). The register held zero rows when this was added, so this is
      -- a schema definition, not a migration.
      filed_date TEXT NOT NULL
    );
  `);
  migrateCategoryCodeNullable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS ap_payment (
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
  db.exec("CREATE INDEX IF NOT EXISTS idx_ap_payment_row_id ON ap_payment(row_id);");
  return db;
}

let singleton: Database | null = null;

function getDb(): Database {
  if (!singleton) singleton = openDb(dbPath());
  return singleton;
}

/** Test-only seam: closes the cached handle so the NEXT call re-opens from
 * (a possibly newly-set) AP_DB_PATH, rather than reusing a stale handle from
 * a previous test file's temp path. */
export function _resetForTests(): void {
  singleton?.close();
  singleton = null;
}

export class ApRowHasPaymentsError extends Error {
  constructor(rowId: string) {
    super(`ap row ${rowId} has payments and cannot be deleted`);
    this.name = "ApRowHasPaymentsError";
  }
}

// ── raw row shapes ─────────────────────────────────────────────────────────

interface RawRow {
  id: string;
  creditor: string;
  item: string;
  amount_satang: number;
  vat_satang: number | null;
  wht_satang: number | null;
  discount_satang: number;
  due_date: string | null;
  entity: string;
  category_code: string | null;
  note: string;
  created_at: string;
  created_by: string;
  filed_date: string;
}

interface RawPayment {
  id: string;
  row_id: string;
  date: string;
  amount_satang: number;
  payment_method: string;
  kind: string;
  installment_number: number | null;
  payer_email: string;
  transaction_id: string;
  created_at: string;
}

function mapPayment(raw: RawPayment): ApPayment {
  return {
    id: raw.id,
    date: raw.date,
    amountSatang: raw.amount_satang,
    paymentMethod: raw.payment_method as PaymentMethod,
    kind: raw.kind as ApPaymentKind,
    installmentNumber: raw.installment_number,
    payerEmail: raw.payer_email,
    transactionId: raw.transaction_id,
  };
}

function loadPayments(db: Database, rowId: string): ApPayment[] {
  const raw = db
    .query("SELECT * FROM ap_payment WHERE row_id = ? ORDER BY date ASC, created_at ASC")
    .all(rowId) as RawPayment[];
  return raw.map(mapPayment);
}

function mapRow(db: Database, raw: RawRow): ApRow {
  const payments = loadPayments(db, raw.id);
  const gross = computeGross(raw.amount_satang, raw.vat_satang, raw.wht_satang);
  const outstanding = computeOutstanding(gross, payments, raw.discount_satang);
  return {
    id: raw.id,
    creditor: raw.creditor,
    item: raw.item,
    amountSatang: raw.amount_satang,
    vatSatang: raw.vat_satang,
    whtSatang: raw.wht_satang,
    discountSatang: raw.discount_satang,
    dueDate: raw.due_date,
    entity: raw.entity,
    categoryCode: raw.category_code as ExpenseCategoryCode | null,
    note: raw.note,
    createdAt: raw.created_at,
    createdBy: raw.created_by,
    // H3 fix: pass filed_date so a row settled with ZERO payments (a
    // discount/WHT alone brought outstanding to <= 0) gets a real settledAt
    // instead of null — see deriveSettledAt's doc comment.
    settledAt: deriveSettledAt(payments, outstanding, raw.filed_date),
    grossSatang: gross,
    outstandingSatang: outstanding,
    payments,
  };
}

// ── row CRUD ────────────────────────────────────────────────────────────

export function createApRow(input: ApRowInput, createdBy: string): string {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  // M1 fix: filed_date is the Bangkok CALENDAR date, computed independently
  // of createdAt's UTC timestamp — see the CREATE TABLE comment above for
  // why these two must not be derived from each other.
  const filedDate = todayBangkok();
  getDb()
    .query(
      `INSERT INTO ap_row
        (id, creditor, item, amount_satang, vat_satang, wht_satang, discount_satang, due_date, entity, category_code, note, created_at, created_by, filed_date)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.creditor,
      input.item,
      input.amountSatang,
      input.vatSatang,
      input.whtSatang,
      input.discountSatang,
      input.dueDate,
      input.entity,
      input.categoryCode,
      input.note,
      createdAt,
      createdBy,
      filedDate,
    );
  return id;
}

export function getApRow(id: string): ApRow | null {
  const db = getDb();
  const raw = db.query("SELECT * FROM ap_row WHERE id = ?").get(id) as RawRow | null;
  if (!raw) return null;
  return mapRow(db, raw);
}

export function updateApRow(id: string, input: ApRowInput): void {
  getDb()
    .query(
      `UPDATE ap_row SET
        creditor = ?, item = ?, amount_satang = ?, vat_satang = ?, wht_satang = ?,
        discount_satang = ?, due_date = ?, entity = ?, category_code = ?, note = ?
       WHERE id = ?`,
    )
    .run(
      input.creditor,
      input.item,
      input.amountSatang,
      input.vatSatang,
      input.whtSatang,
      input.discountSatang,
      input.dueDate,
      input.entity,
      input.categoryCode,
      input.note,
      id,
    );
}

/** Throws ApRowHasPaymentsError rather than deleting when the row has ≥1
 * payment (spec §6) — the ONE place this rule lives; src/server/server.ts
 * translates the thrown error into the route's 409. */
export function deleteApRow(id: string): void {
  const db = getDb();
  const count = (db.query("SELECT COUNT(*) as n FROM ap_payment WHERE row_id = ?").get(id) as { n: number }).n;
  if (count > 0) throw new ApRowHasPaymentsError(id);
  db.query("DELETE FROM ap_row WHERE id = ?").run(id);
}

export function listApRows(filter: ApListFilter): ApRow[] {
  const db = getDb();
  const raw = db.query("SELECT * FROM ap_row").all() as RawRow[];
  if (filter.mode === "all") return raw.map((r) => mapRow(db, r));
  if (filter.mode === "open") return raw.map((r) => mapRow(db, r)).filter((r) => r.outstandingSatang > 0);
  // month: กำหนดชำระ's month, falling back to the FILING month when the due
  // date is blank (spec §2 "Month filter matches กำหนดชำระ's month...").
  // M1 fix: filters on the raw `filed_date` (Bangkok calendar date) BEFORE
  // mapping to ApRow, never on `created_at` (a full UTC timestamp) — a row
  // created 00:00-07:00 Bangkok on the 1st used to slice into the PREVIOUS
  // month, because UTC's calendar date at that moment is still the last day
  // of the prior month.
  const month = filter.month!;
  return raw.filter((r) => (r.due_date ?? r.filed_date).slice(0, 7) === month).map((r) => mapRow(db, r));
}

/** Always over every currently-unsettled row regardless of the active
 * filter/month — the header's "what do we still owe" summary never changes
 * just because the clerk is looking at ทั้งหมด or a past month (spec §3). */
export function computeApSummary(today: string): ApSummary {
  const openRows = listApRows({ mode: "open" });
  const totalOutstandingSatang = openRows.reduce((sum, r) => sum + r.outstandingSatang, 0);
  const overdueCount = openRows.filter((r) => deriveStatus(r.dueDate, r.outstandingSatang, today) === "overdue").length;
  return { totalOutstandingSatang, overdueCount };
}

/** Distinct creditors, each carrying the categoryCode/entity of its MOST
 * RECENT row (spec §4 item 1 "prefills หมวดค่าใช้จ่าย and ในนาม from its
 * most recent row"). */
export function listCreditorHints(): ApCreditorHint[] {
  const db = getDb();
  const raw = db
    .query("SELECT creditor, category_code, entity FROM ap_row ORDER BY created_at DESC")
    .all() as { creditor: string; category_code: string | null; entity: string }[];
  const seen = new Set<string>();
  const hints: ApCreditorHint[] = [];
  for (const r of raw) {
    if (seen.has(r.creditor)) continue;
    seen.add(r.creditor);
    hints.push({ creditor: r.creditor, categoryCode: r.category_code as ExpenseCategoryCode | null, entity: r.entity });
  }
  return hints;
}

// ── payments ────────────────────────────────────────────────────────────

export interface AddApPaymentInput {
  date: string;
  amountSatang: number;
  paymentMethod: PaymentMethod;
  kind: ApPaymentKind;
  installmentNumber: number | null;
  payerEmail: string;
  transactionId: string;
}

/**
 * Records a payment, and — RULING 1 — when `categoryCodeToPersist` is
 * non-null (the row being paid had no category yet, and the payment form
 * collected one), sets the row's OWN category_code to it in the SAME sqlite
 * transaction as the payment insert, so the two writes can never land only
 * one of the other (e.g. a category change surviving a payment insert that
 * then fails, or vice versa). Callers with a row that already has a
 * category pass null (the default) and this is a plain payment insert,
 * unchanged from pre-ruling behavior. `db.transaction` rolls back BOTH
 * statements if either throws. */
export function addApPayment(
  rowId: string,
  input: AddApPaymentInput,
  categoryCodeToPersist: ExpenseCategoryCode | null = null,
): string {
  const db = getDb();
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const run = db.transaction(() => {
    if (categoryCodeToPersist !== null) {
      db.query("UPDATE ap_row SET category_code = ? WHERE id = ?").run(categoryCodeToPersist, rowId);
    }
    db.query(
      `INSERT INTO ap_payment
        (id, row_id, date, amount_satang, payment_method, kind, installment_number, payer_email, transaction_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      rowId,
      input.date,
      input.amountSatang,
      input.paymentMethod,
      input.kind,
      input.installmentNumber,
      input.payerEmail,
      input.transactionId,
      createdAt,
    );
  });
  run();
  return id;
}

export function getApPayment(rowId: string, paymentId: string): ApPayment | null {
  const raw = getDb().query("SELECT * FROM ap_payment WHERE id = ? AND row_id = ?").get(paymentId, rowId) as
    | RawPayment
    | null;
  if (!raw) return null;
  return mapPayment(raw);
}

export function deleteApPayment(rowId: string, paymentId: string): void {
  getDb().query("DELETE FROM ap_payment WHERE id = ? AND row_id = ?").run(paymentId, rowId);
}
