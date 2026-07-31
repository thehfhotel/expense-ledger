// Client stub for the headless ezBookkeeping engine
// (container `expense-ledger-engine`, reached over the compose `default`
// network at ENGINE_URL — see docker-compose.yml and README "Identity
// table"). Every call carries the engine's own API token
// (ENGINE_API_TOKEN, minted once at first-boot — see README "First-boot
// procedure") as a bearer credential.
//
// Hard rule (see CLAUDE.md): ENGINE_API_TOKEN is a server-only secret.
// Never forward it to the browser — every engine call must originate from
// this server process, not from client-side code calling the engine (or
// ENGINE_URL) directly.
//
// Dormant behaviour: ENGINE_API_TOKEN unset -> engineFetch() throws
// EngineNotConfiguredError before any request leaves this process, and
// engineConfigured() lets a route check first and answer 503 instead.

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
 * relative to /api/v1, e.g. "/accounts/list.json". Adds the bearer token
 * and a JSON content-type unless the body is FormData (multipart uploads
 * set their own boundary-bearing content-type). */
export async function engineFetch<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<EngineEnvelope<T>> {
  if (!engineConfigured()) throw new EngineNotConfiguredError();

  const url = `${ENGINE_URL()}/api/v1${path.startsWith("/") ? path : `/${path}`}`;
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${ENGINE_API_TOKEN()}`);
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
