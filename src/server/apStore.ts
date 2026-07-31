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
      category_code TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL
    );
  `);
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
  category_code: string;
  note: string;
  created_at: string;
  created_by: string;
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
    categoryCode: raw.category_code as ExpenseCategoryCode,
    note: raw.note,
    createdAt: raw.created_at,
    createdBy: raw.created_by,
    settledAt: deriveSettledAt(payments, outstanding),
    grossSatang: gross,
    outstandingSatang: outstanding,
    payments,
  };
}

// ── row CRUD ────────────────────────────────────────────────────────────

export function createApRow(input: ApRowInput, createdBy: string): string {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  getDb()
    .query(
      `INSERT INTO ap_row
        (id, creditor, item, amount_satang, vat_satang, wht_satang, discount_satang, due_date, entity, category_code, note, created_at, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
  const rows = raw.map((r) => mapRow(db, r));
  if (filter.mode === "all") return rows;
  if (filter.mode === "open") return rows.filter((r) => r.outstandingSatang > 0);
  // month: กำหนดชำระ's month, falling back to the created month when the due
  // date is blank (spec §2 "Month filter matches กำหนดชำระ's month...").
  const month = filter.month!;
  return rows.filter((r) => (r.dueDate ?? r.createdAt).slice(0, 7) === month);
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
    .all() as { creditor: string; category_code: string; entity: string }[];
  const seen = new Set<string>();
  const hints: ApCreditorHint[] = [];
  for (const r of raw) {
    if (seen.has(r.creditor)) continue;
    seen.add(r.creditor);
    hints.push({ creditor: r.creditor, categoryCode: r.category_code as ExpenseCategoryCode, entity: r.entity });
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

export function addApPayment(rowId: string, input: AddApPaymentInput): string {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  getDb()
    .query(
      `INSERT INTO ap_payment
        (id, row_id, date, amount_satang, payment_method, kind, installment_number, payer_email, transaction_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
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
