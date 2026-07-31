// Thin HTTP client for the headless ezBookkeeping engine, for the
// operator-run seed/import scripts under scripts/. This talks to the
// engine's loopback host-port mapping (127.0.0.1:4051, or an SSH tunnel to
// it) directly - a different path than src/server/engine.ts, which is the
// frontend's in-container client reaching the engine over the compose
// `default` network as http://expense-ledger-engine:8080. Same wire
// conventions (Bearer token, JSON envelope), different env vars (EBK_URL /
// EBK_TOKEN here vs ENGINE_URL / ENGINE_API_TOKEN there) because these
// scripts run from an operator's machine, not inside the frontend container.
//
// All endpoint shapes below were verified against the ezBookkeeping v1.6.1
// source (github.com/mayswind/ezbookkeeping, tag v1.6.1):
//   - cmd/webserver.go for the route table
//   - pkg/models/transaction.go, transaction_category.go, account.go,
//     transaction_tag.go for request/response field names and JSON tags
//   - pkg/core/context_web.go for the X-Timezone-Name / X-Timezone-Offset
//     requirement (GetClientTimezone() errors out transaction- and
//     account-mutating/listing endpoints if neither header resolves)
//   - src/consts/numeral.ts / src/consts/currency.ts for the amount unit
//     (all amounts are integers scaled by a flat factor of 100 - satang for
//     THB - regardless of the currency's own decimal "fraction"; see
//     lib/currency.ts)

export interface EngineEnvelope<T> {
  success: boolean;
  result?: T;
  errorCode?: number;
  errorMessage?: string;
}

export class EngineRequestError extends Error {
  constructor(
    message: string,
    public readonly errorCode?: number,
  ) {
    super(message);
    this.name = "EngineRequestError";
  }
}

export interface EngineClientOptions {
  baseUrl: string;
  token: string;
}

export interface EngineCategory {
  id: string;
  name: string;
  parentId: string;
  type: number;
  icon: string;
  color: string;
  subCategories?: EngineCategory[];
}

export interface EngineAccount {
  id: string;
  name: string;
  parentId: string;
  category: number;
  type: number;
  icon: string;
  color: string;
  currency: string;
}

export interface EngineTag {
  id: string;
  name: string;
  groupId: string;
}

export interface EngineTransaction {
  id: string;
  type: number;
  categoryId: string;
  time: number;
  utcOffset: number;
  sourceAccountId: string;
  sourceAmount: number;
  tagIds: string[];
  comment: string;
}

// Enum values verified against pkg/models/transaction.go,
// transaction_category.go and account.go (v1.6.1).
export const TRANSACTION_TYPE_EXPENSE = 3;
export const CATEGORY_TYPE_EXPENSE = 2;
export const ACCOUNT_CATEGORY_CASH = 1;
export const ACCOUNT_CATEGORY_CHECKING = 2;
export const ACCOUNT_TYPE_SINGLE = 1;

const BANGKOK_TZ_NAME = "Asia/Bangkok";
const BANGKOK_TZ_OFFSET_MINUTES = "420";

export interface AddCategoryInput {
  name: string;
  /** "0" for a top-level (primary) category. */
  parentId: string;
  icon: string;
  color: string;
}

export interface AddAccountInput {
  name: string;
  category: number;
  icon: string;
  color: string;
}

export interface AddTransactionInput {
  categoryId: string;
  time: number;
  utcOffset: number;
  sourceAccountId: string;
  sourceAmount: number;
  comment: string;
  tagIds: string[];
}

export function createEngineClient({ baseUrl, token }: EngineClientOptions) {
  const base = baseUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${token}`);
    // Every transaction- and account-mutating/listing endpoint requires a
    // resolvable client timezone (see pkg/core/context_web.go
    // GetClientTimezone()) or it errors with ErrClientTimezoneOffsetInvalid.
    // Sent unconditionally; harmless on endpoints that ignore it.
    headers.set("X-Timezone-Name", BANGKOK_TZ_NAME);
    headers.set("X-Timezone-Offset", BANGKOK_TZ_OFFSET_MINUTES);
    if (init.body !== undefined && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const res = await fetch(`${base}/api/v1${path}`, { ...init, headers });
    const body = (await res.json()) as EngineEnvelope<T>;

    if (!body.success) {
      throw new EngineRequestError(body.errorMessage || `engine request failed: ${path} (http ${res.status})`, body.errorCode);
    }

    return body.result as T;
  }

  return {
    /** GET /transaction/categories/list.json?type=2 - result is keyed by stringified category type, e.g. result["2"]. */
    listExpenseCategories: () => request<Record<string, EngineCategory[]>>(`/transaction/categories/list.json?type=${CATEGORY_TYPE_EXPENSE}`),

    addCategory: (input: AddCategoryInput) =>
      request<EngineCategory>(`/transaction/categories/add.json`, {
        method: "POST",
        body: JSON.stringify({ ...input, type: CATEGORY_TYPE_EXPENSE }),
      }),

    listAccounts: () => request<EngineAccount[]>(`/accounts/list.json`),

    addAccount: (input: AddAccountInput) =>
      request<EngineAccount>(`/accounts/add.json`, {
        method: "POST",
        body: JSON.stringify({
          ...input,
          type: ACCOUNT_TYPE_SINGLE,
          currency: "THB",
          balance: 0,
          balanceTime: Math.floor(Date.now() / 1000),
        }),
      }),

    listTags: () => request<EngineTag[]>(`/transaction/tags/list.json`),

    addTag: (name: string) => request<EngineTag>(`/transaction/tags/add.json`, { method: "POST", body: JSON.stringify({ name }) }),

    addTransaction: (input: AddTransactionInput) =>
      request<EngineTransaction>(`/transactions/add.json`, {
        method: "POST",
        body: JSON.stringify({
          type: TRANSACTION_TYPE_EXPENSE,
          categoryId: input.categoryId,
          time: input.time,
          utcOffset: input.utcOffset,
          sourceAccountId: input.sourceAccountId,
          sourceAmount: input.sourceAmount,
          tagIds: input.tagIds,
          comment: input.comment,
        }),
      }),

    /** GET /transactions/list/by_month.json - unlike list.json this has no pagination cap, so it's the right call for a whole month. */
    listTransactionsByMonth: (year: number, month: number) =>
      request<{ items: EngineTransaction[]; totalCount: number }>(
        `/transactions/list/by_month.json?year=${year}&month=${month}&type=${TRANSACTION_TYPE_EXPENSE}`,
      ),

    deleteTransaction: (id: string) => request<boolean>(`/transactions/delete.json`, { method: "POST", body: JSON.stringify({ id }) }),
  };
}

export type EngineClient = ReturnType<typeof createEngineClient>;
