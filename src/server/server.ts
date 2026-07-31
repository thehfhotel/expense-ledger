import { existsSync } from "node:fs";
import { join } from "node:path";
import { identify } from "./access.ts";
import {
  attachExpensePhoto,
  createExpenseTransaction,
  deleteExpenseTransaction,
  detachExpensePhoto,
  getExpenseTransactionDate,
  getMonthExpenseTransactions,
  modifyExpenseTransaction,
} from "./engine.ts";
import { attributedCommentLength, ENGINE_COMMENT_MAX_RUNES } from "./attribution.ts";
import { EXPENSE_CATEGORIES, isExpenseCategoryCode, type ExpenseCategoryCode } from "../shared/categories.ts";
import { currentMonthBangkok, isValidIso, isValidMonth, todayBangkok } from "../shared/date.ts";
import { isPaymentMethod } from "../shared/types.ts";
import type {
  CategoryListItem,
  CategoryTotal,
  ExpenseInput,
  ExpenseTransaction,
  Me,
  MonthExpensesResponse,
} from "../shared/types.ts";
import { AMOUNT_SATANG_MAX, AMOUNT_SATANG_MIN, COMMENT_MAX_LEN } from "../shared/types.ts";

const isProd = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 3000);

const distDir = join(process.cwd(), "dist", "client");
const indexPath = join(distDir, "index.html");

// Paths that look like a real static asset (recognized extension) 404 when
// missing rather than falling back to the SPA shell — see income-ledger's
// server.ts for the same rule and its rationale (a stale client asking for
// a chunk a newer deploy purged must fail loudly, not get HTML back as JS).
const ASSET_PATH_RE = /\.(js|css|map|png|jpg|jpeg|webp|svg|ico|woff2?)$/i;

/** GET /healthz: 200 "ok", ZERO dependency on the engine or any DB — see
 * CLAUDE.md hard rules. The deploy shim's health check must pass even if
 * ezBookkeeping (expense-ledger-engine) is briefly unreachable. Never make
 * this call out to the engine. */
function healthz(): Response {
  return new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

// ── /api routes ────────────────────────────────────────────────────────
// Every route is gated by identify() (Cf-Access-Jwt-Assertion, verified
// RS256 — src/server/access.ts). For requests that arrive over Cloudflare
// Access this is a second layer behind the edge decision, but for LAN-path
// requests (this container's host-port mapping is reachable directly by
// anything already on the LAN, bypassing Cloudflare entirely) it is the
// ONLY gate — see access.ts's file-level note for why ACCESS_AUD must be
// non-empty in production for this check to mean anything.
//
// The client's api() helper (src/client/api.ts) treats ANY 401/403 — or a
// non-JSON content-type, which is what an expired Access session's login
// HTML redirect looks like — as "session expired". Every response below is
// always JSON, so a plain 401 here is enough to trigger that path; never
// swallow auth failure into a differently-shaped error.

const CATEGORY_LIST: CategoryListItem[] = EXPENSE_CATEGORIES.map((c) => ({
  code: c.code,
  label: c.label,
  building: c.building,
  recurring: c.recurring,
  order: c.order,
}));

/** Wraps a route body that talks to the engine: ANY failure (network
 * failure, ENGINE_API_TOKEN unset, an unmapped category/account, the
 * engine's own success:false) becomes the frontend spec §6 contract exactly
 * — 502 `{ "error": "engine_unreachable" }` — so the client's single
 * reject-with-retry path covers every engine failure mode uniformly. The
 * real error is still logged server-side for operators. */
async function withEngine(fn: () => Promise<Response>): Promise<Response> {
  try {
    return await fn();
  } catch (err) {
    console.error("[engine]", err instanceof Error ? err.message : err);
    return json(502, { error: "engine_unreachable" });
  }
}

/** 409s a write when `id`'s transaction falls outside the current Bangkok
 * calendar month — frontend spec §4 "Current month only". The server is
 * the real gate; client-side disabling in the edit drawer is only a hint. */
async function currentMonthLockResponse(id: string): Promise<Response | null> {
  const date = await getExpenseTransactionDate(id);
  if (date.slice(0, 7) !== currentMonthBangkok()) {
    return json(409, { error: "current month only" });
  }
  return null;
}

/** 400s a write whose FINAL stored comment (clerk text plus the appended
 * `[hf:by=<email>]` attribution token — src/server/attribution.ts) would
 * exceed the engine's 255-rune comment cap (M2 fix). The client-facing
 * COMMENT_MAX_LEN (200) alone doesn't account for a long caller email (e.g.
 * a LINE-synthetic address), so this budgets against the ACTUAL identity at
 * request time rather than a fixed guess — distinct from and checked before
 * the 502 engine_unreachable path, since retrying a request this shape
 * would never succeed. */
function commentBudgetResponse(comment: string, email: string): Response | null {
  if (attributedCommentLength(comment, email) > ENGINE_COMMENT_MAX_RUNES) {
    return json(400, { error: "comment too long with attribution" });
  }
  return null;
}

async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}

type ValidatedInput = { ok: true; value: ExpenseInput } | { ok: false; error: string };

/** Validates the body shared by POST /api/expenses and PATCH
 * /api/expenses/:id (frontend spec §9). `comment` is the clerk's raw text —
 * the server appends attribution separately (src/server/attribution.ts);
 * this function only bounds-checks it.
 *
 * H4 fix: the current-month check below applies to BOTH create and patch,
 * since this function gates both routes — previously only an EXISTING
 * transaction's date was checked (currentMonthLockResponse, PATCH/DELETE/
 * photo routes only), so an entry could be created directly in a closed
 * past month, or an edit could move an entry INTO one, with no check at
 * all. The existing-date lock below is unchanged and still applies on top
 * of this for edits. */
function validateExpenseInput(body: unknown): ValidatedInput {
  if (typeof body !== "object" || body === null) return { ok: false, error: "invalid body" };
  const b = body as Record<string, unknown>;

  if (typeof b.date !== "string" || !isValidIso(b.date)) return { ok: false, error: "invalid date" };
  if (b.date > todayBangkok()) return { ok: false, error: "date must not be in the future" };
  if (b.date.slice(0, 7) !== currentMonthBangkok()) return { ok: false, error: "date must be in the current month" };

  if (
    typeof b.amountSatang !== "number" ||
    !Number.isInteger(b.amountSatang) ||
    b.amountSatang < AMOUNT_SATANG_MIN ||
    b.amountSatang > AMOUNT_SATANG_MAX
  ) {
    return { ok: false, error: "invalid amountSatang" };
  }

  if (!isExpenseCategoryCode(b.categoryCode)) return { ok: false, error: "invalid categoryCode" };
  if (!isPaymentMethod(b.paymentMethod)) return { ok: false, error: "invalid paymentMethod" };

  const comment = b.comment;
  if (typeof comment !== "string" || comment.length > COMMENT_MAX_LEN) {
    return { ok: false, error: "invalid comment" };
  }

  return {
    ok: true,
    value: {
      date: b.date,
      amountSatang: b.amountSatang,
      categoryCode: b.categoryCode as ExpenseCategoryCode,
      paymentMethod: b.paymentMethod,
      comment,
    },
  };
}

/** Compares two ezBookkeeping transaction ids (decimal-digit strings,
 * ~3.8e18 — well above Number.MAX_SAFE_INTEGER) for a DESCENDING sort
 * without going through `Number()`, which silently collapses distinct ids
 * at that magnitude to the same float (M1 fix — two ids one apart at 19
 * digits compare equal under `Number(b.id) - Number(a.id)`). Both ids are
 * plain positive-integer strings with no leading zeros, so (length, then
 * lexicographic) ordering is exact: more digits is always a larger number,
 * and same-length numeric strings compare the same as their numeric value,
 * digit by digit. */
function compareIdsDescending(aId: string, bId: string): number {
  if (aId.length !== bId.length) return bId.length - aId.length;
  if (aId === bId) return 0;
  return aId > bId ? -1 : 1;
}

/** Builds GET /api/expenses?month=YYYY-MM's response: per-category totals
 * and the grand total, computed here from the month's transactions (never
 * from the engine's own statistics endpoint — see README's dev notes on
 * why: this list already carries every field the totals need, verified,
 * where the statistics response shape was not). Sorted วันที่ desc then
 * insertion desc (frontend spec §3.3); ezBookkeeping ids are assigned by a
 * monotonic sequence, so id desc is a reliable insertion-order proxy within
 * a day. Exported so tests can drive it directly with hand-built
 * transactions — see server.test.ts. */
export function buildMonthResponse(items: ExpenseTransaction[]): MonthExpensesResponse {
  const totalsByCategory: Partial<Record<ExpenseCategoryCode, CategoryTotal>> = {};
  let totalSatang = 0;
  for (const item of items) {
    totalSatang += item.amountSatang;
    const existing = totalsByCategory[item.categoryCode];
    if (existing) {
      existing.count += 1;
      existing.amountSatang += item.amountSatang;
    } else {
      totalsByCategory[item.categoryCode] = { count: 1, amountSatang: item.amountSatang };
    }
  }

  const sorted = [...items].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    return compareIdsDescending(a.id, b.id);
  });

  return { items: sorted, totalsByCategory, totalSatang };
}

async function handleApi(req: Request, url: URL): Promise<Response> {
  const identity = await identify(req);
  if (!identity) return json(401, { error: "unauthenticated" });

  const path = url.pathname.slice(4) || "/"; // strip "/api" prefix
  const method = req.method;

  if (method === "GET" && path === "/me") {
    const me: Me = { email: identity.email };
    return json(200, me);
  }

  if (method === "GET" && path === "/categories") {
    return json(200, CATEGORY_LIST);
  }

  if (method === "GET" && path === "/expenses") {
    const month = url.searchParams.get("month");
    if (!month || !isValidMonth(month)) return json(400, { error: "invalid month" });
    return withEngine(async () => {
      const items = await getMonthExpenseTransactions(month);
      return json(200, buildMonthResponse(items));
    });
  }

  if (method === "POST" && path === "/expenses") {
    const validated = validateExpenseInput(await readJsonBody(req));
    if (!validated.ok) return json(400, { error: validated.error });
    const budgetError = commentBudgetResponse(validated.value.comment, identity.email);
    if (budgetError) return budgetError;
    return withEngine(async () => {
      const id = await createExpenseTransaction(validated.value, identity.email);
      return json(201, { id });
    });
  }

  const expenseMatch = path.match(/^\/expenses\/([^/]+)$/);
  if (expenseMatch) {
    const id = expenseMatch[1]!;

    if (method === "PATCH") {
      const validated = validateExpenseInput(await readJsonBody(req));
      if (!validated.ok) return json(400, { error: validated.error });
      const budgetError = commentBudgetResponse(validated.value.comment, identity.email);
      if (budgetError) return budgetError;
      return withEngine(async () => {
        const locked = await currentMonthLockResponse(id);
        if (locked) return locked;
        await modifyExpenseTransaction(id, validated.value, identity.email);
        return json(200, { id });
      });
    }

    if (method === "DELETE") {
      return withEngine(async () => {
        const locked = await currentMonthLockResponse(id);
        if (locked) return locked;
        await deleteExpenseTransaction(id);
        return new Response(null, { status: 204 });
      });
    }
  }

  const photoMatch = path.match(/^\/expenses\/([^/]+)\/photo$/);
  if (method === "POST" && photoMatch) {
    const id = photoMatch[1]!;
    return withEngine(async () => {
      const locked = await currentMonthLockResponse(id);
      if (locked) return locked;

      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        return json(400, { error: "invalid multipart body" });
      }
      const file = form.get("picture");
      if (!(file instanceof Blob)) return json(400, { error: "missing picture field" });
      const filename = file instanceof File ? file.name : "photo.jpg";

      const uploaded = await attachExpensePhoto(id, file, filename);
      return json(201, uploaded);
    });
  }

  const photoDeleteMatch = path.match(/^\/expenses\/([^/]+)\/photo\/([^/]+)$/);
  if (method === "DELETE" && photoDeleteMatch) {
    const [, id, photoId] = photoDeleteMatch as unknown as [string, string, string];
    return withEngine(async () => {
      const locked = await currentMonthLockResponse(id);
      if (locked) return locked;
      await detachExpensePhoto(id, photoId);
      return new Response(null, { status: 204 });
    });
  }

  return json(404, { error: "not found" });
}

async function serveStatic(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const filePath = url.pathname === "/" ? indexPath : join(distDir, url.pathname);
  // Prevent path traversal: the resolved file must stay inside distDir.
  if (!filePath.startsWith(distDir)) return new Response("nope", { status: 400 });

  const f = Bun.file(filePath);
  if (await f.exists()) return new Response(f);

  if (ASSET_PATH_RE.test(url.pathname)) {
    return new Response("not found", { status: 404 });
  }

  // SPA fallback for any other (extensionless) navigation — /entry,
  // /month/2026-07, etc.
  return new Response(Bun.file(indexPath), {
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" },
  });
}

/** The full request dispatcher, exported so tests can drive it directly
 * without a live socket — see server.test.ts. */
export async function fetchHandler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/healthz") return healthz();
  if (url.pathname.startsWith("/api/")) return handleApi(req, url);
  return serveStatic(req);
}

if (isProd && !existsSync(indexPath)) {
  console.error(`[fatal] missing ${indexPath}. Run \`bun run build\` first.`);
  process.exit(1);
}

// Only start a real listener when run directly (`bun src/server/server.ts`),
// not when imported by the test suite.
if (import.meta.main) {
  if (isProd) {
    const server = Bun.serve({ port, fetch: fetchHandler });
    console.log(`▶︎ http://localhost:${server.port} (prod)`);
  } else {
    // Dev: HTML import lets Bun bundle the React client on the fly with HMR
    // (bunfig.toml registers the Tailwind plugin for this dev-serve path;
    // the production build registers it directly in build.ts's Bun.build
    // call instead).
    const indexHtml = (await import("../client/index.html")).default;
    const server = Bun.serve({
      port,
      development: true,
      routes: {
        "/": indexHtml,
        "/entry": indexHtml,
        "/month/:month": indexHtml,
        "/healthz": () => healthz(),
        "/api/*": (req: Request) => handleApi(req, new URL(req.url)),
      },
    });
    console.log(`▶︎ http://localhost:${server.port} (dev)`);
  }
}
