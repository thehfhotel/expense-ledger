// Pure, unit-testable helpers for turning this app's own wire shapes
// (src/shared/types.ts's ExpenseInput) into the ezBookkeeping engine's
// transaction wire shape, and back. Nothing here calls the network — see
// engine.ts for the HTTP calls that use these.
//
// ezBookkeeping facts below verified against the upstream source at tag
// v1.6.1 (github.com/mayswind/ezbookkeeping, mirrored by
// github.com/thehfhotel/ezbookkeeping) — see README.md "ezBookkeeping API
// notes" for the citation style this repo uses.
//
// - pkg/models/transaction.go: transaction type constants —
//   MODIFY_BALANCE=1, INCOME=2, EXPENSE=3, TRANSFER=4. Every entry this app
//   writes is an expense: TRANSACTION_TYPE_EXPENSE = 3.
// - pkg/models/transaction_category.go: a SEPARATE enum for category type —
//   CATEGORY_TYPE_INCOME=1, CATEGORY_TYPE_EXPENSE=2, CATEGORY_TYPE_TRANSFER=3.
//   Do not reuse the transaction-type constant (3) when filtering categories
//   — expense CATEGORIES are type 2, expense TRANSACTIONS are type 3.
// - pkg/api/transactions.go's modify handler: TransactionModifyRequest is a
//   FULL OVERWRITE — every field (type/categoryId/time/utcOffset/
//   sourceAccountId/sourceAmount/comment/pictureIds/tagIds) is required and
//   replaces the stored row wholesale. There is no "patch just this field"
//   request shape, so any single-field edit (amount, category, or attaching
//   a photo) must fetch the full current transaction first and resend every
//   field with the one change applied — see engine.ts's mergeAndModify().
// - TransactionCreateRequest/ModifyRequest.UtcOffset (binding:
//   "min=-720,max=840", no `required` tag): read directly from the JSON
//   body, NOT derived from the X-Timezone-* header on these two endpoints
//   (unlike transactions/list/by_month.json, which 400s without a resolvable
//   client timezone) — so this app must compute and send it explicitly.
// - sourceAmount is "the smallest currency unit" — for THB (ISO 4217 minor
//   unit 2, i.e. satang) this is numerically identical to this app's own
//   amountSatang. No scaling is applied; see buildEngineTransactionPayload's
//   test for a same-value passthrough, which is the invariant this app
//   actually depends on (a silent extra ×100 or /100 would be the real bug).
// - Modify handler builds stored time via
//   utils.GetMinTransactionTimeFromUnixTime(...Time) — the wire `time`
//   field is Unix SECONDS, not milliseconds.
// - pictureIds is always an array (possibly empty), both on create and
//   modify — never a bare scalar id.
//
// Category/account enum values and the category-list response shape below
// are cross-checked against scripts/lib/ezbk-client.ts — the operator-run
// migration scripts' independently-sourced engine client (this repo's
// concurrent seed/import work) — which cites pkg/models/transaction.go,
// transaction_category.go, account.go and pkg/core/context_web.go directly.
// Notably: GET /transaction/categories/list.json?type=2 returns a response
// KEYED BY STRINGIFIED CATEGORY TYPE (`result["2"]`), not a bare array; and
// AccountCategory is a plain numeric enum (CASH=1, CHECKING=2) — engine.ts
// matches accounts on that field, not by name.

export const TRANSACTION_TYPE_EXPENSE = 3;
export const CATEGORY_TYPE_EXPENSE = 2;
/** ezBookkeeping's AccountCategory enum (pkg/models/account.go) — the two
 * values this app's two seeded accounts (เงินสด / ธนาคาร) can take. */
export const ACCOUNT_CATEGORY_CASH = 1;
export const ACCOUNT_CATEGORY_CHECKING = 2;

/** Bangkok carries a fixed UTC+7 offset year-round (no DST) — see
 * src/shared/date.ts's todayBangkok(). Expressed in minutes to match the
 * engine's `utcOffset` field. */
export const BANGKOK_UTC_OFFSET_MINUTES = 420;

export class CategoryNotMappedError extends Error {
  constructor(code: string) {
    super(`no ezBookkeeping category is mapped for code "${code}"`);
    this.name = "CategoryNotMappedError";
  }
}

export class AccountNotMappedError extends Error {
  constructor(paymentMethod: string) {
    super(`no ezBookkeeping account is mapped for payment method "${paymentMethod}"`);
    this.name = "AccountNotMappedError";
  }
}

/** Resolves this app's `code` to the engine's secondary-category id via the
 * (already-fetched) code -> id map. Throws CategoryNotMappedError rather
 * than silently mis-filing an entry under the wrong P&L line. */
export function resolveCategoryEngineId(map: ReadonlyMap<string, string>, code: string): string {
  const id = map.get(code);
  if (id === undefined) throw new CategoryNotMappedError(code);
  return id;
}

/** Resolves this app's `paymentMethod` ("cash" | "bank") to the engine's
 * source-account id. Throws AccountNotMappedError rather than posting an
 * expense against the wrong account. */
export function resolveAccountEngineId(map: ReadonlyMap<string, string>, paymentMethod: string): string {
  const id = map.get(paymentMethod);
  if (id === undefined) throw new AccountNotMappedError(paymentMethod);
  return id;
}

/**
 * Builds the Unix-seconds `time` the engine expects for a transaction dated
 * `dateIso` (a Bangkok calendar date with no time-of-day of its own — the UI
 * never collects one, see frontend spec §2.1). Combines `dateIso`'s Y-M-D
 * with `now`'s wall-clock time-of-day AS OBSERVED IN BANGKOK, so that:
 *   - same-day entries created later in a batch naturally get a later
 *     `time`, preserving insertion order for the itemized list's "วันที่
 *     desc then insertion desc" sort (frontend spec §3.3) without a
 *     separate sequence column;
 *   - a back-dated entry still gets a valid, unique-enough instant on the
 *     correct calendar day.
 * `now` defaults to the real clock and is a parameter purely so tests are
 * deterministic.
 */
export function buildTransactionUnixTimeSeconds(dateIso: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const partValue = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? "0");
  // formatToParts renders midnight as "24" with hour12:false in some ICU
  // builds — normalize to 0 so Date.UTC doesn't roll into the next day.
  const hour = partValue("hour") % 24;
  const minute = partValue("minute");
  const second = partValue("second");

  const [y, m, d] = dateIso.split("-").map(Number);
  // Bangkok local wall-clock (y,m,d,hour,minute,second) is UTC+7, so the
  // matching UTC instant is that wall-clock value minus 7 hours.
  const utcMs = Date.UTC(y!, m! - 1, d!, hour, minute, second) - BANGKOK_UTC_OFFSET_MINUTES * 60_000;
  return Math.floor(utcMs / 1000);
}

/** Inverse of buildTransactionUnixTimeSeconds's date half: the Bangkok
 * calendar date ("YYYY-MM-DD") a stored `time` (Unix seconds) falls on.
 * Always converts via the Asia/Bangkok zone directly — `time` is an
 * absolute instant, so the engine's stored `utcOffset` (metadata about the
 * writer's own clock, not part of the instant) plays no part in this. Used
 * both to render ExpenseTransaction.date and to enforce the "current month
 * only" edit/delete lock (frontend spec §4) against the transaction's REAL
 * date, never a client-supplied one. */
export function deriveDateFromEngineTime(timeUnixSeconds: number): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(timeUnixSeconds * 1000));
}

export interface EngineTransactionPayload {
  type: number;
  categoryId: string;
  time: number;
  utcOffset: number;
  sourceAccountId: string;
  sourceAmount: number;
  comment: string;
  pictureIds: string[];
  tagIds: string[];
  hideAmount: boolean;
}

export interface BuildEngineTransactionInput {
  amountSatang: number;
  categoryEngineId: string;
  sourceAccountEngineId: string;
  /** The FINAL stored comment (attribution token already appended — see
   * src/server/attribution.ts). This module never touches attribution. */
  comment: string;
  dateIso: string;
  now?: Date;
  pictureIds?: string[];
  /** Tag ids to resend on a full-overwrite modify.json (H2 fix). This app's
   * client never builds tags itself (v1 sends none on CREATE — frontend
   * spec's "NOT built" list, so this defaults to empty there), but
   * scripts/import-workbook.ts tags every imported row with
   * `import:<YYYY-MM>` for its own idempotency (re-import safety). Since
   * modify.json is a full overwrite, a caller that fetches an EXISTING
   * transaction (any edit, or a photo attach/detach) MUST pass that
   * transaction's current tagIds back through here or the import tag is
   * silently wiped — see engine.ts's modifyExpenseTransaction /
   * attachExpensePhoto / detachExpensePhoto, which mirror exactly this
   * fetch-then-resend pattern already used for pictureIds. */
  tagIds?: string[];
}

/** Builds the full request body for both transactions/add.json and
 * transactions/modify.json (the latter needs every field resent — see the
 * file-level note on full-overwrite semantics). Never invents a destination
 * account (this app only ever writes plain expenses, never transfers).
 * `tagIds` defaults to empty (a newly created transaction has none), but
 * see BuildEngineTransactionInput's doc comment: any caller resending an
 * EXISTING transaction must pass its current tagIds through, or a
 * full-overwrite modify silently strips them (H2 fix). */
export function buildEngineTransactionPayload(input: BuildEngineTransactionInput): EngineTransactionPayload {
  return {
    type: TRANSACTION_TYPE_EXPENSE,
    categoryId: input.categoryEngineId,
    time: buildTransactionUnixTimeSeconds(input.dateIso, input.now),
    utcOffset: BANGKOK_UTC_OFFSET_MINUTES,
    sourceAccountId: input.sourceAccountEngineId,
    sourceAmount: input.amountSatang,
    comment: input.comment,
    pictureIds: input.pictureIds ?? [],
    tagIds: input.tagIds ?? [],
    hideAmount: false,
  };
}
