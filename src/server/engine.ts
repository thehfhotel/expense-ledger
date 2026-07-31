// Client for the headless ezBookkeeping engine (container
// `expense-ledger-engine`, reached over the compose `default` network at
// ENGINE_URL — see docker-compose.yml and README "Identity table"). Every
// call carries the engine's own API token (ENGINE_API_TOKEN, minted once at
// first-boot — see README "First-boot procedure") as a bearer credential.
//
// Hard rule (see CLAUDE.md): ENGINE_API_TOKEN is a server-only secret.
// Never forward it to the browser — every engine call must originate from
// this server process, not from client-side code calling the engine (or
// ENGINE_URL) directly.
//
// Dormant behaviour: ENGINE_API_TOKEN unset -> engineFetch() throws
// EngineNotConfiguredError before any request leaves this process, and
// engineConfigured() lets a route check first and answer accordingly.
//
// ezBookkeeping facts used below are verified against the upstream source
// at tag v1.6.1 (github.com/mayswind/ezbookkeeping, mirrored by
// github.com/thehfhotel/ezbookkeeping) — see README.md "ezBookkeeping API
// notes" and transactionBuilder.ts's file-level note for the specific
// citations (transaction type/category type enums, full-overwrite modify
// semantics, Unix-seconds time, satang-equivalent sourceAmount).

import { EXPENSE_CATEGORIES, type ExpenseCategoryCode } from "../shared/categories.ts";
import type { ExpenseInput, ExpensePhoto, ExpenseTransaction, PaymentMethod } from "../shared/types.ts";
import { appendAttribution, parseAttribution } from "./attribution.ts";
import {
  ACCOUNT_CATEGORY_CASH,
  ACCOUNT_CATEGORY_CHECKING,
  CATEGORY_TYPE_EXPENSE,
  TRANSACTION_TYPE_EXPENSE,
  buildEngineTransactionPayload,
  deriveDateFromEngineTime,
  resolveAccountEngineId,
  resolveCategoryEngineId,
} from "./transactionBuilder.ts";

const ENGINE_URL = (): string => (process.env.ENGINE_URL || "http://expense-ledger-engine:8080").replace(/\/+$/, "");
const ENGINE_API_TOKEN = (): string => process.env.ENGINE_API_TOKEN || "";

export function engineConfigured(): boolean {
  return !!ENGINE_API_TOKEN();
}

export class EngineNotConfiguredError extends Error {
  constructor() {
    super("ENGINE_API_TOKEN is not set - the ezBookkeeping engine client is dormant");
    this.name = "EngineNotConfiguredError";
  }
}

/** The JSON envelope every ezBookkeeping API response wraps its payload in
 * (see https://ezbookkeeping.mayswind.net/httpapi/ and
 * cmd/webserver.go's bindApi -> utils.PrintJsonSuccessResult /
 * PrintJsonErrorResult in the upstream source). */
export interface EngineEnvelope<T> {
  success: boolean;
  result?: T;
  errorCode?: number;
  errorMessage?: string;
}

/** Low-level fetch wrapper for the ezBookkeeping HTTP API. `path` is
 * relative to /api/v1, e.g. "/accounts/list.json". Adds the bearer token, a
 * JSON content-type unless the body is FormData (multipart uploads set
 * their own boundary-bearing content-type), and BOTH timezone headers on
 * every call — per scripts/lib/ezbk-client.ts's citation of
 * pkg/core/context_web.go's GetClientTimezone(), every transaction- and
 * account-mutating/listing endpoint requires a resolvable client timezone
 * or errors with ErrClientTimezoneOffsetInvalid; sending both is harmless
 * where only one is actually consulted. */
export async function engineFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<EngineEnvelope<T>> {
  if (!engineConfigured()) throw new EngineNotConfiguredError();

  const url = `${ENGINE_URL()}/api/v1${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${ENGINE_API_TOKEN()}`);
  headers.set("x-timezone-name", "Asia/Bangkok");
  headers.set("x-timezone-offset", "420");
  if (!(init.body instanceof FormData) && init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(url, { ...init, headers });
  return (await res.json()) as EngineEnvelope<T>;
}

/** Uploads a transaction receipt photo — POST
 * /api/v1/transaction/pictures/upload.json, multipart/form-data, file field
 * "picture" (see README "ezBookkeeping API notes" for the verified request
 * shape / response). Returns the engine's pictureId + originalUrl on
 * success; throws with the engine's errorMessage otherwise. */
export async function uploadTransactionPicture(
  file: Blob,
  filename: string,
): Promise<{ pictureId: string; originalUrl: string }> {
  const form = new FormData();
  form.append("picture", file, filename);

  const res = await engineFetch<{ pictureId: string; originalUrl: string }>(
    "/transaction/pictures/upload.json",
    { method: "POST", body: form },
  );
  if (!res.success || !res.result) {
    throw new Error(res.errorMessage || "transaction picture upload failed");
  }
  return res.result;
}

// ── Category id map: code (this app) <-> engine secondary-category id ─────
// "As-code" seeding (frontend spec: "category-management UI" is explicitly
// NOT built) means scripts/seed.ts creates the real tree: one PRIMARY
// category per src/shared/categories.ts group, named by that group's Thai
// `label`, holding one or more SECONDARY categories underneath — named by
// `building` for the three building-scoped groups (water/electricity/
// phone), or carrying that SAME label again for every other leaf (a
// primary needs exactly one secondary purely so a transaction has
// somewhere to post — see scripts/categories.json and scripts/seed.ts).
// This module never hardcodes a numeric id: it walks the engine's live
// category tree matching on (primary.name === label, secondary.name ===
// building ?? label) — the same Thai text already in categories.ts, never
// this app's internal `code` string, which the engine never sees — caching
// the result and refreshing once on a lookup miss (a category seeded after
// this server process started).

interface EngineCategoryNode {
  id: number | string;
  name: string;
  subCategories?: EngineCategoryNode[] | null;
}

interface CategoryCache {
  codeToId: Map<ExpenseCategoryCode, string>;
  idToCode: Map<string, ExpenseCategoryCode>;
}

let categoryCache: CategoryCache | null = null;

async function loadCategoryCache(): Promise<CategoryCache> {
  // CATEGORY_TYPE_EXPENSE=2 here — the transaction_category.go enum, NOT
  // the transaction type enum (EXPENSE=3) — see transactionBuilder.ts. The
  // response is keyed by stringified category type (e.g. result["2"]), per
  // scripts/lib/ezbk-client.ts's citation — not a bare array.
  const res = await engineFetch<Record<string, EngineCategoryNode[]>>(
    `/transaction/categories/list.json?type=${CATEGORY_TYPE_EXPENSE}`,
  );
  if (!res.success || !res.result) {
    throw new Error(res.errorMessage || "failed to list ezBookkeeping categories");
  }
  const primaries = res.result[String(CATEGORY_TYPE_EXPENSE)] ?? [];

  const codeToId = new Map<ExpenseCategoryCode, string>();
  const idToCode = new Map<string, ExpenseCategoryCode>();
  for (const category of EXPENSE_CATEGORIES) {
    const primary = primaries.find((p) => p.name === category.label);
    const secondaryName = category.building ?? category.label;
    const secondary = primary?.subCategories?.find((s) => s.name === secondaryName);
    if (secondary) {
      const id = String(secondary.id);
      codeToId.set(category.code, id);
      idToCode.set(id, category.code);
    }
  }
  categoryCache = { codeToId, idToCode };
  return categoryCache;
}

async function ensureCategoryCache(): Promise<CategoryCache> {
  return categoryCache ?? loadCategoryCache();
}

async function categoryCodeToEngineId(code: ExpenseCategoryCode): Promise<string> {
  const cache = await ensureCategoryCache();
  if (cache.codeToId.has(code)) return cache.codeToId.get(code)!;
  // Cache miss: refresh once (a category seeded after this process started)
  // before giving up — see the module doc comment.
  const fresh = await loadCategoryCache();
  return resolveCategoryEngineId(fresh.codeToId, code);
}

/** Best-effort id -> code for rendering the month list. A foreign/legacy
 * category (created directly in the engine's own UI, outside this app's
 * seeded 21) falls back to "other" rather than breaking the whole month
 * render. */
function engineIdToCategoryCode(id: string): ExpenseCategoryCode {
  return categoryCache?.idToCode.get(id) ?? "other";
}

// ── Account id map: "cash" | "bank" <-> engine sourceAccountId ─────────────
// Same as-code seeding story as categories (scripts/seed.ts creates exactly
// two: เงินสด / ธนาคาร), but matched on the engine's own AccountCategory
// enum (pkg/models/account.go — CASH=1, CHECKING=2, confirmed via
// scripts/lib/ezbk-client.ts) rather than by name, which is exact and
// immune to a future rename of either account. Falls back positionally for
// a plain two-account install that somehow carries neither category value,
// so a seeding quirk doesn't leave the whole app unusable.

interface EngineAccountNode {
  id: number | string;
  name: string;
  category: number;
  subAccounts?: EngineAccountNode[] | null;
}

interface AccountCache {
  methodToId: Map<PaymentMethod, string>;
  idToMethod: Map<string, PaymentMethod>;
}

let accountCache: AccountCache | null = null;

function flattenAccounts(nodes: EngineAccountNode[]): { id: string; category: number }[] {
  const out: { id: string; category: number }[] = [];
  for (const node of nodes) {
    out.push({ id: String(node.id), category: node.category });
    if (node.subAccounts && node.subAccounts.length > 0) out.push(...flattenAccounts(node.subAccounts));
  }
  return out;
}

async function loadAccountCache(): Promise<AccountCache> {
  const res = await engineFetch<EngineAccountNode[]>("/accounts/list.json");
  if (!res.success || !res.result) {
    throw new Error(res.errorMessage || "failed to list ezBookkeeping accounts");
  }
  const flat = flattenAccounts(res.result);
  const methodToId = new Map<PaymentMethod, string>();
  for (const account of flat) {
    if (!methodToId.has("cash") && account.category === ACCOUNT_CATEGORY_CASH) methodToId.set("cash", account.id);
    else if (!methodToId.has("bank") && account.category === ACCOUNT_CATEGORY_CHECKING) {
      methodToId.set("bank", account.id);
    }
  }
  if (flat.length === 2) {
    if (!methodToId.has("cash")) methodToId.set("cash", flat[0]!.id);
    if (!methodToId.has("bank")) methodToId.set("bank", flat[1]!.id);
  }
  const idToMethod = new Map<string, PaymentMethod>();
  for (const [method, id] of methodToId) idToMethod.set(id, method);
  accountCache = { methodToId, idToMethod };
  return accountCache;
}

async function ensureAccountCache(): Promise<AccountCache> {
  return accountCache ?? loadAccountCache();
}

async function paymentMethodToEngineId(method: PaymentMethod): Promise<string> {
  const cache = await ensureAccountCache();
  if (cache.methodToId.has(method)) return cache.methodToId.get(method)!;
  const fresh = await loadAccountCache();
  return resolveAccountEngineId(fresh.methodToId, method);
}

function engineIdToPaymentMethod(id: string): PaymentMethod {
  return accountCache?.idToMethod.get(id) ?? "cash";
}

// ── Transaction mapping ────────────────────────────────────────────────────

/** The subset of ezBookkeeping's TransactionInfoResponse this app reads —
 * see the "get single transaction" citation in transactionBuilder.ts's
 * file-level note. Picture object field names (`pictureId`/`originalUrl`
 * vs `id`/`url`) are read defensively since the exact GET response field
 * names for an attached picture were not pinned down against source. */
interface EngineTransactionRaw {
  id: number | string;
  categoryId: number | string;
  time: number;
  sourceAccountId: number | string;
  sourceAmount: number;
  comment: string;
  pictureIds?: (number | string)[];
  pictures?: { pictureId?: number | string; id?: number | string; originalUrl?: string; url?: string }[];
}

function extractPictureIds(raw: EngineTransactionRaw): string[] {
  if (Array.isArray(raw.pictureIds)) return raw.pictureIds.map(String);
  if (Array.isArray(raw.pictures)) return raw.pictures.map((p) => String(p.pictureId ?? p.id));
  return [];
}

function extractPhotos(raw: EngineTransactionRaw): ExpensePhoto[] {
  if (!Array.isArray(raw.pictures)) return [];
  return raw.pictures.map((p) => ({ id: String(p.pictureId ?? p.id), url: String(p.originalUrl ?? p.url ?? "") }));
}

function mapEngineTransaction(raw: EngineTransactionRaw): ExpenseTransaction {
  const { display, by } = parseAttribution(raw.comment ?? "");
  return {
    id: String(raw.id),
    date: deriveDateFromEngineTime(raw.time),
    amountSatang: raw.sourceAmount,
    categoryCode: engineIdToCategoryCode(String(raw.categoryId)),
    paymentMethod: engineIdToPaymentMethod(String(raw.sourceAccountId)),
    comment: display,
    by,
    photos: extractPhotos(raw),
  };
}

/** GET /api/v1/transactions/list/by_month.json — the whole month in ONE
 * call, verified from source (TransactionListInMonthByPageRequest has no
 * page/count cap, unlike the general transactions/list.json which caps at
 * 50 and would need a page-loop). `with_pictures=true` so photo thumbnails
 * never need a second round trip per transaction. */
export async function getMonthExpenseTransactions(monthIso: string): Promise<ExpenseTransaction[]> {
  const [year, month] = monthIso.split("-").map(Number);
  await Promise.all([ensureCategoryCache(), ensureAccountCache()]);
  const res = await engineFetch<{ items: EngineTransactionRaw[]; totalCount: number }>(
    `/transactions/list/by_month.json?year=${year}&month=${month}&type=${TRANSACTION_TYPE_EXPENSE}&with_pictures=true`,
  );
  if (!res.success || !res.result) {
    throw new Error(res.errorMessage || "failed to list this month's transactions");
  }
  return res.result.items.map(mapEngineTransaction);
}

async function getEngineTransaction(id: string): Promise<EngineTransactionRaw> {
  const res = await engineFetch<EngineTransactionRaw>(
    `/transactions/get.json?id=${encodeURIComponent(id)}&with_pictures=true`,
  );
  if (!res.success || !res.result) throw new Error(res.errorMessage || "transaction not found");
  return res.result;
}

/** The Bangkok calendar date this transaction is really recorded on — used
 * to enforce the "current month only" edit/delete lock (frontend spec §4)
 * server-side, never trusting a client-supplied date. */
export async function getExpenseTransactionDate(id: string): Promise<string> {
  const existing = await getEngineTransaction(id);
  return deriveDateFromEngineTime(existing.time);
}

/** POST /api/v1/transactions/add.json. `email` is the verified Access
 * identity — appendAttribution appends it server-side (§5); the client
 * never sends or renders the token. Returns the new transaction's id.
 *
 * ASSUMPTION (flagged for verification against a live engine): the
 * response `result` carries the created transaction's id directly under an
 * `id` field, mirroring the get/list shapes above — the exact add.json
 * success response shape was not independently re-verified from source. */
export async function createExpenseTransaction(input: ExpenseInput, email: string): Promise<string> {
  const [categoryEngineId, sourceAccountEngineId] = await Promise.all([
    categoryCodeToEngineId(input.categoryCode),
    paymentMethodToEngineId(input.paymentMethod),
  ]);
  const payload = buildEngineTransactionPayload({
    amountSatang: input.amountSatang,
    categoryEngineId,
    sourceAccountEngineId,
    comment: appendAttribution(input.comment, email),
    dateIso: input.date,
  });
  const res = await engineFetch<{ id?: number | string }>("/transactions/add.json", {
    method: "POST",
    body: JSON.stringify(payload),
  });
  if (!res.success) throw new Error(res.errorMessage || "failed to create transaction");
  const id = res.result?.id;
  if (id === undefined || id === null) throw new Error("ezBookkeeping did not return a transaction id");
  return String(id);
}

/** POST /api/v1/transactions/modify.json — a FULL overwrite (verified from
 * source, see transactionBuilder.ts): fetches the existing row first so
 * fields this call doesn't touch (pictureIds) are resent unchanged, per
 * rule 6 re-appends attribution with the CURRENT editor regardless of who
 * wrote it before. */
export async function modifyExpenseTransaction(id: string, input: ExpenseInput, email: string): Promise<void> {
  const [existing, categoryEngineId, sourceAccountEngineId] = await Promise.all([
    getEngineTransaction(id),
    categoryCodeToEngineId(input.categoryCode),
    paymentMethodToEngineId(input.paymentMethod),
  ]);
  const payload = buildEngineTransactionPayload({
    amountSatang: input.amountSatang,
    categoryEngineId,
    sourceAccountEngineId,
    comment: appendAttribution(input.comment, email),
    dateIso: input.date,
    pictureIds: extractPictureIds(existing),
  });
  const res = await engineFetch(`/transactions/modify.json`, {
    method: "POST",
    body: JSON.stringify({ id, ...payload }),
  });
  if (!res.success) throw new Error(res.errorMessage || "failed to modify transaction");
}

export async function deleteExpenseTransaction(id: string): Promise<void> {
  const res = await engineFetch("/transactions/delete.json", {
    method: "POST",
    body: JSON.stringify({ id }),
  });
  if (!res.success) throw new Error(res.errorMessage || "failed to delete transaction");
}

/**
 * Attaches an uploaded photo to an existing transaction. Ordering per
 * frontend spec §2.6: the transaction already exists (created first); this
 * uploads the picture, then re-sends the transaction (full overwrite, as
 * above) with the new picture id appended. The clerk's comment/attribution
 * is left exactly as it was — attaching a photo is not treated as an edit
 * of the clerk's text, so `by` does not change on a pure photo attach.
 */
export async function attachExpensePhoto(
  id: string,
  file: Blob,
  filename: string,
): Promise<{ id: string; url: string }> {
  const uploaded = await uploadTransactionPicture(file, filename);
  const existing = await getEngineTransaction(id);
  const pictureIds = Array.from(new Set([...extractPictureIds(existing), uploaded.pictureId]));
  const payload = buildEngineTransactionPayload({
    amountSatang: existing.sourceAmount,
    categoryEngineId: String(existing.categoryId),
    sourceAccountEngineId: String(existing.sourceAccountId),
    comment: existing.comment,
    dateIso: deriveDateFromEngineTime(existing.time),
    pictureIds,
  });
  const res = await engineFetch("/transactions/modify.json", {
    method: "POST",
    body: JSON.stringify({ id, ...payload }),
  });
  if (!res.success) throw new Error(res.errorMessage || "failed to attach photo");
  return { id: uploaded.pictureId, url: uploaded.originalUrl };
}

/** Removes one photo from a transaction (full overwrite, same as above);
 * the comment/attribution is left untouched, same reasoning as attach. */
export async function detachExpensePhoto(id: string, photoId: string): Promise<void> {
  const existing = await getEngineTransaction(id);
  const pictureIds = extractPictureIds(existing).filter((pid) => pid !== photoId);
  const payload = buildEngineTransactionPayload({
    amountSatang: existing.sourceAmount,
    categoryEngineId: String(existing.categoryId),
    sourceAccountEngineId: String(existing.sourceAccountId),
    comment: existing.comment,
    dateIso: deriveDateFromEngineTime(existing.time),
    pictureIds,
  });
  const res = await engineFetch("/transactions/modify.json", {
    method: "POST",
    body: JSON.stringify({ id, ...payload }),
  });
  if (!res.success) throw new Error(res.errorMessage || "failed to remove photo");
}

/** Test-only seam: lets server.test.ts reset the in-process category/account
 * caches between test files without reaching into module internals. */
export const _internal = {
  resetCaches(): void {
    categoryCache = null;
    accountCache = null;
  },
};
