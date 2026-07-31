import type {
  CategoryListItem,
  CreateExpenseResponse,
  ExpenseInput,
  Me,
  MonthExpensesResponse,
  UploadPhotoResponse,
} from "../shared/types.ts";

// One api() helper for every endpoint — shape copied from income-ledger's
// src/client/api.ts, with one deliberate divergence (frontend spec §6):
// income-ledger has no 401 branch at all, because Cloudflare Access never
// lets an unauthenticated request reach the SPA on first load. That
// reasoning stops holding once a session expires while the tab is already
// open — the estate's documented "open but dead" symptom — so this app
// classifies a response as SESSION EXPIRED whenever the status is 401/403
// OR the content-type isn't JSON (an expired Access session's login-page
// redirect looks exactly like that). Never swallow this into the generic
// error path — App.tsx renders a distinct full-screen overlay for it.
//
// A 502 carrying `{ "error": "engine_unreachable" }` (the proxy's exact
// contract for "the engine didn't answer") is its own error type too, so
// callers can show the reject-with-retry chip instead of a generic failure
// message.

export class SessionExpiredError extends Error {
  constructor() {
    super("session expired");
    this.name = "SessionExpiredError";
  }
}

export class EngineUnreachableError extends Error {
  constructor() {
    super("engine_unreachable");
    this.name = "EngineUnreachableError";
  }
}

// App.tsx registers the one place session-expiry renders (a full-screen
// overlay, never a route) — every api() call funnels through here so no
// page can forget to show it.
let sessionExpiredHandler: (() => void) | null = null;
export function setSessionExpiredHandler(handler: (() => void) | null): void {
  sessionExpiredHandler = handler;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (!(init.body instanceof FormData) && init.body !== undefined && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  let res: Response;
  try {
    res = await fetch(`/api${path}`, { ...init, headers });
  } catch {
    // A real network failure reaching our own server reads the same as the
    // engine not answering, from the clerk's point of view — same
    // reject-with-retry affordance either way.
    throw new EngineUnreachableError();
  }

  const contentType = res.headers.get("content-type") ?? "";
  if (res.status === 401 || res.status === 403 || !contentType.includes("application/json")) {
    sessionExpiredHandler?.();
    throw new SessionExpiredError();
  }

  if (res.status === 204) return undefined as T;

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    sessionExpiredHandler?.();
    throw new SessionExpiredError();
  }

  if (!res.ok) {
    const errorField = (body as { error?: string } | null)?.error;
    if (res.status === 502 && errorField === "engine_unreachable") throw new EngineUnreachableError();
    throw new Error(errorField || res.statusText || `HTTP ${res.status}`);
  }

  return body as T;
}

export function getMe(): Promise<Me> {
  return api("/me");
}

export function listCategories(): Promise<CategoryListItem[]> {
  return api("/categories");
}

export function getMonthExpenses(month: string): Promise<MonthExpensesResponse> {
  return api(`/expenses?month=${encodeURIComponent(month)}`);
}

export function createExpense(input: ExpenseInput): Promise<CreateExpenseResponse> {
  return api("/expenses", { method: "POST", body: JSON.stringify(input) });
}

export function updateExpense(id: string, input: ExpenseInput): Promise<CreateExpenseResponse> {
  return api(`/expenses/${id}`, { method: "PATCH", body: JSON.stringify(input) });
}

export function deleteExpense(id: string): Promise<void> {
  return api(`/expenses/${id}`, { method: "DELETE" });
}

export function uploadExpensePhoto(id: string, file: Blob, filename: string): Promise<UploadPhotoResponse> {
  const form = new FormData();
  form.append("picture", file, filename);
  return api(`/expenses/${id}/photo`, { method: "POST", body: form });
}

export function deleteExpensePhoto(id: string, photoId: string): Promise<void> {
  return api(`/expenses/${id}/photo/${photoId}`, { method: "DELETE" });
}
