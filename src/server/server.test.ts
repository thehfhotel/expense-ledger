// Server route tests. Mirrors income-ledger's src/server/server.test.ts
// pattern: drive the exported request handler directly, no live socket
// needed. NODE_ENV/DEV_USER are toggled per-test (access.ts reads them at
// call time, not at import time) to exercise both the JWT gate and the
// dev-mode bypass without a real Cloudflare Access JWT.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as apStore from "./apStore.ts";
import { _internal as engineInternal } from "./engine.ts";
import { buildTransactionUnixTimeSeconds } from "./transactionBuilder.ts";
import { buildMonthResponse, fetchHandler } from "./server.ts";
import { todayBangkok } from "../shared/date.ts";
import type { ExpenseTransaction } from "../shared/types.ts";

function resetAuthEnv() {
  delete process.env.DEV_USER;
  process.env.NODE_ENV = "";
  delete process.env.ENGINE_API_TOKEN;
}

function devRequest(path: string, init?: RequestInit): Request {
  process.env.NODE_ENV = "development";
  process.env.DEV_USER = "tester@thehfhotel.org";
  return new Request(`http://localhost${path}`, init);
}

/** Same as devRequest but with a caller-chosen identity email — used by the
 * M2 comment-budget tests, which need a long email to trigger the engine's
 * 255-rune comment cap. */
function devRequestAs(email: string, path: string, init?: RequestInit): Request {
  process.env.NODE_ENV = "development";
  process.env.DEV_USER = email;
  return new Request(`http://localhost${path}`, init);
}

/** A date guaranteed to fall in a DIFFERENT (earlier) calendar month than
 * whenever this test runs — 40 days back always crosses at least one month
 * boundary, since no month is longer than 31 days. Used by the H4 tests. */
function pastMonthDate(): string {
  return new Date(Date.now() - 1000 * 60 * 60 * 24 * 40).toISOString().slice(0, 10);
}

describe("GET /healthz", () => {
  test('returns 200 "ok" with no dependency on the engine or a DB', async () => {
    const res = await fetchHandler(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("/api auth gate", () => {
  afterEach(resetAuthEnv);

  test("401s with a JSON {error} body when no Cf-Access-Jwt-Assertion header is present", async () => {
    resetAuthEnv();
    const res = await fetchHandler(new Request("http://localhost/api/me"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });

  test("401s on every /api route uniformly, not just /me", async () => {
    resetAuthEnv();
    const res = await fetchHandler(new Request("http://localhost/api/categories"));
    expect(res.status).toBe(401);
  });

  test("dev-mode DEV_USER bypass resolves identity without a real JWT", async () => {
    const res = await fetchHandler(devRequest("/api/me"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "tester@thehfhotel.org" });
  });

  test("DEV_USER is ignored outside NODE_ENV=development — fails closed", async () => {
    process.env.NODE_ENV = "production";
    process.env.DEV_USER = "tester@thehfhotel.org";
    const res = await fetchHandler(new Request("http://localhost/api/me"));
    expect(res.status).toBe(401);
  });

  test("an unknown /api route still 401s before it can 404 for an unauthenticated caller", async () => {
    resetAuthEnv();
    const res = await fetchHandler(new Request("http://localhost/api/nope"));
    expect(res.status).toBe(401);
  });
});

describe("GET /api/categories", () => {
  afterEach(resetAuthEnv);

  test("returns the 21 static leaves, no engine dependency", async () => {
    const res = await fetchHandler(devRequest("/api/categories"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { code: string }[];
    expect(body.length).toBe(21);
    expect(body.some((c) => c.code === "other")).toBe(true);
  });
});

describe("GET /api/expenses", () => {
  afterEach(resetAuthEnv);

  test("400s on a malformed month before ever reaching the engine", async () => {
    const res = await fetchHandler(devRequest("/api/expenses?month=not-a-month"));
    expect(res.status).toBe(400);
  });

  test("502s engine_unreachable when ENGINE_API_TOKEN is unset (dormant engine client)", async () => {
    const res = await fetchHandler(devRequest("/api/expenses?month=2026-07"));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "engine_unreachable" });
  });
});

describe("POST /api/expenses validation", () => {
  afterEach(resetAuthEnv);

  function post(body: unknown) {
    return devRequest("/api/expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("400s on a malformed date", async () => {
    const res = await fetchHandler(
      post({ date: "not-a-date", amountSatang: 100, categoryCode: "other", paymentMethod: "cash", comment: "" }),
    );
    expect(res.status).toBe(400);
  });

  test("400s on a future date", async () => {
    const future = new Date(Date.now() + 1000 * 60 * 60 * 24 * 60).toISOString().slice(0, 10);
    const res = await fetchHandler(
      post({ date: future, amountSatang: 100, categoryCode: "other", paymentMethod: "cash", comment: "" }),
    );
    expect(res.status).toBe(400);
  });

  test("400s on a non-positive amount", async () => {
    const res = await fetchHandler(
      post({ date: "2026-07-01", amountSatang: 0, categoryCode: "other", paymentMethod: "cash", comment: "" }),
    );
    expect(res.status).toBe(400);
  });

  test("400s on an unknown category code", async () => {
    const res = await fetchHandler(
      post({
        date: "2026-07-01",
        amountSatang: 100,
        categoryCode: "not-a-real-code",
        paymentMethod: "cash",
        comment: "",
      }),
    );
    expect(res.status).toBe(400);
  });

  test("400s on an invalid payment method", async () => {
    const res = await fetchHandler(
      post({ date: "2026-07-01", amountSatang: 100, categoryCode: "other", paymentMethod: "crypto", comment: "" }),
    );
    expect(res.status).toBe(400);
  });

  test("400s on a comment over the bound", async () => {
    const res = await fetchHandler(
      post({
        date: "2026-07-01",
        amountSatang: 100,
        categoryCode: "other",
        paymentMethod: "cash",
        comment: "x".repeat(201),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("a valid body passes validation and reaches the (dormant) engine, surfacing 502", async () => {
    const res = await fetchHandler(
      post({ date: todayBangkok(), amountSatang: 100, categoryCode: "other", paymentMethod: "cash", comment: "ok" }),
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "engine_unreachable" });
  });
});

describe("M5 fix: /api write routes reject a non-JSON content-type with 415", () => {
  afterEach(resetAuthEnv);

  test("POST /api/expenses 415s a text/plain body before ever parsing it", async () => {
    const res = await fetchHandler(
      devRequest("/api/expenses", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ date: todayBangkok(), amountSatang: 100, categoryCode: "other", paymentMethod: "cash", comment: "" }),
      }),
    );
    expect(res.status).toBe(415);
  });

  test("POST /api/expenses 415s a request with no content-type header at all", async () => {
    const res = await fetchHandler(
      devRequest("/api/expenses", {
        method: "POST",
        body: JSON.stringify({ date: todayBangkok(), amountSatang: 100, categoryCode: "other", paymentMethod: "cash", comment: "" }),
      }),
    );
    expect(res.status).toBe(415);
  });

  test("PATCH /api/expenses/:id 415s a non-JSON content-type", async () => {
    const res = await fetchHandler(
      devRequest("/api/expenses/123", {
        method: "PATCH",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ date: todayBangkok(), amountSatang: 100, categoryCode: "other", paymentMethod: "cash", comment: "" }),
      }),
    );
    expect(res.status).toBe(415);
  });
});

describe("current-month lock on create (H4 fix — create had no month check at all)", () => {
  afterEach(resetAuthEnv);

  function post(body: unknown) {
    return devRequest("/api/expenses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("400s when creating an entry dated in a closed past month", async () => {
    const res = await fetchHandler(
      post({ date: pastMonthDate(), amountSatang: 100, categoryCode: "other", paymentMethod: "cash", comment: "" }),
    );
    expect(res.status).toBe(400);
  });
});

describe("current-month lock on edit/delete/photo routes", () => {
  afterEach(resetAuthEnv);

  test("PATCH /api/expenses/:id surfaces 502 (not a crash) when the engine is dormant", async () => {
    const res = await fetchHandler(
      devRequest("/api/expenses/123", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: todayBangkok(), amountSatang: 100, categoryCode: "other", paymentMethod: "cash", comment: "" }),
      }),
    );
    expect(res.status).toBe(502);
  });

  test("400s when patching an entry to move its date into a closed past month (H4 fix)", async () => {
    const res = await fetchHandler(
      devRequest("/api/expenses/123", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: pastMonthDate(), amountSatang: 100, categoryCode: "other", paymentMethod: "cash", comment: "" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("DELETE /api/expenses/:id surfaces 502 when the engine is dormant", async () => {
    const res = await fetchHandler(devRequest("/api/expenses/123", { method: "DELETE" }));
    expect(res.status).toBe(502);
  });

  test("POST /api/expenses/:id/photo surfaces 502 when the engine is dormant, before parsing multipart", async () => {
    const res = await fetchHandler(devRequest("/api/expenses/123/photo", { method: "POST" }));
    expect(res.status).toBe(502);
  });
});

describe("H2 fix: ordinary /api/expenses routes refuse a transaction the AP register manages", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    resetAuthEnv();
  });

  /** Mocks the engine as configured and reporting that transaction "123"
   * carries tag id "42", which the tag list resolves to an "ap:row-abc"
   * name — exactly the shape isApManagedTransaction (src/server/engine.ts)
   * checks for. */
  function mockApTaggedTransaction() {
    process.env.ENGINE_API_TOKEN = "test-token";
    global.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/transactions/get.json")) {
        return new Response(
          JSON.stringify({ success: true, result: { id: "123", time: Math.floor(Date.now() / 1000), tagIds: ["42"] } }),
        );
      }
      if (href.includes("/transaction/tags/list.json")) {
        return new Response(JSON.stringify({ success: true, result: [{ id: "42", name: "ap:row-abc" }] }));
      }
      throw new Error(`unexpected engine call in test: ${href}`);
    }) as typeof fetch;
  }

  test("PATCH /api/expenses/:id 409s ap_managed instead of reaching modifyExpenseTransaction", async () => {
    mockApTaggedTransaction();
    const res = await fetchHandler(
      devRequest("/api/expenses/123", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: todayBangkok(), amountSatang: 100, categoryCode: "other", paymentMethod: "cash", comment: "" }),
      }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "ap_managed" });
  });

  test("DELETE /api/expenses/:id 409s ap_managed instead of reaching deleteExpenseTransaction", async () => {
    mockApTaggedTransaction();
    const res = await fetchHandler(devRequest("/api/expenses/123", { method: "DELETE" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "ap_managed" });
  });

  test("an UNTAGGED transaction is unaffected — still reaches the ordinary current-month lock", async () => {
    process.env.ENGINE_API_TOKEN = "test-token";
    global.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/transactions/get.json")) {
        return new Response(JSON.stringify({ success: true, result: { id: "123", time: Math.floor(Date.now() / 1000), tagIds: [] } }));
      }
      throw new Error(`unexpected engine call in test: ${href}`);
    }) as typeof fetch;

    const res = await fetchHandler(devRequest("/api/expenses/123", { method: "DELETE" }));
    // No ap: tag -> isApManagedTransaction is false -> falls through past it:
    // the current-month lock passes (mocked `time` is "now"), then the route
    // reaches deleteExpenseTransaction, whose /transactions/delete.json call
    // isn't mocked here and throws — surfacing as 502, never 409. This
    // proves the ap_managed check does NOT fire for an untagged transaction,
    // rather than merely happening to short-circuit earlier for some other
    // reason.
    expect(res.status).toBe(502);
  });
});

describe("buildMonthResponse item sort — BigInt-safe id comparison (M1 fix)", () => {
  function makeItem(id: string, overrides: Partial<ExpenseTransaction> = {}): ExpenseTransaction {
    return {
      id,
      date: "2026-07-15",
      amountSatang: 100,
      categoryCode: "other",
      paymentMethod: "cash",
      comment: "",
      by: null,
      photos: [],
      ...overrides,
    };
  }

  test("orders two same-date ids that differ by 1 at 19 digits correctly", () => {
    const lower = makeItem("3800000000000000001");
    const higher = makeItem("3800000000000000002");
    // Sanity check the precision-loss premise this fix guards against:
    // Number() collapses both of these ids to the identical float, which is
    // exactly why `Number(b.id) - Number(a.id)` used to compare them equal.
    expect(Number(lower.id)).toBe(Number(higher.id));

    const { items } = buildMonthResponse([lower, higher]);
    expect(items.map((i) => i.id)).toEqual(["3800000000000000002", "3800000000000000001"]);
  });

  test("still sorts by date desc first, id desc only within the same date", () => {
    const earlierDate = makeItem("2", { date: "2026-07-01" });
    const laterDate = makeItem("1", { date: "2026-07-20" });
    const { items } = buildMonthResponse([earlierDate, laterDate]);
    expect(items.map((i) => i.id)).toEqual(["1", "2"]);
  });
});

describe("comment length budget including attribution (M2 fix)", () => {
  afterEach(resetAuthEnv);

  // total stored length = comment.length + 1 (LF) + "[hf:by=" (7) + email.length + "]" (1)
  // = comment.length + email.length + 9. With a 200-char comment, any email
  // over 46 chars pushes the total past the engine's 255-rune cap.
  const longEmail = `${"a".repeat(50)}@thehfhotel.org`;

  test("400s with an error distinct from engine_unreachable when clerk text + attribution would exceed the engine's 255-rune cap", async () => {
    const res = await fetchHandler(
      devRequestAs(longEmail, "/api/expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date: todayBangkok(),
          amountSatang: 100,
          categoryCode: "other",
          paymentMethod: "cash",
          comment: "x".repeat(200),
        }),
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).not.toBe("engine_unreachable");
  });

  test("enforces the same budget on PATCH, not just create", async () => {
    const res = await fetchHandler(
      devRequestAs(longEmail, "/api/expenses/123", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date: todayBangkok(),
          amountSatang: 100,
          categoryCode: "other",
          paymentMethod: "cash",
          comment: "x".repeat(200),
        }),
      }),
    );
    expect(res.status).toBe(400);
  });

  test("a shorter comment with the same long email fits under the engine cap and reaches the (dormant) engine", async () => {
    const res = await fetchHandler(
      devRequestAs(longEmail, "/api/expenses", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          date: todayBangkok(),
          amountSatang: 100,
          categoryCode: "other",
          paymentMethod: "cash",
          comment: "ok",
        }),
      }),
    );
    expect(res.status).toBe(502);
  });
});

// ── AP register ("ค้างจ่าย") routes ──────────────────────────────────────
// Every AP test gets its own temp sqlite file (AP_DB_PATH + apStore's
// _resetForTests) so tests never share state or touch the real
// /app/data/ap.db default path.

function baseApRowBody(overrides: Record<string, unknown> = {}) {
  return {
    creditor: "Booking.com",
    item: "ค่าคอมมิชชั่น ก.ค. 69",
    amountSatang: 10_000,
    categoryCode: "commission-booking",
    entity: "HF",
    ...overrides,
  };
}

describe("AP register: auth gate", () => {
  afterEach(resetAuthEnv);

  test("401s with the same JSON {error} shape as every other /api route", async () => {
    resetAuthEnv();
    const res = await fetchHandler(new Request("http://localhost/api/ap/rows"));
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ error: "unauthenticated" });
  });
});

describe("AP register: DB lazy-open", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ap-lazy-open-test-"));
    dbPath = join(tmpDir, "ap.db");
    process.env.AP_DB_PATH = dbPath;
    apStore._resetForTests();
  });

  afterEach(() => {
    resetAuthEnv();
    apStore._resetForTests();
    delete process.env.AP_DB_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("GET /healthz never touches the AP database, even before the volume dir exists", async () => {
    expect(existsSync(dbPath)).toBe(false);
    const res = await fetchHandler(new Request("http://localhost/healthz"));
    expect(res.status).toBe(200);
    expect(existsSync(dbPath)).toBe(false);
  });

  test("server boot (module import) alone never creates the db file", () => {
    // fetchHandler/server.ts is already imported at the top of this file by
    // the time this test runs; if import-time code touched the AP store,
    // the file would already exist here.
    expect(existsSync(dbPath)).toBe(false);
  });

  test("the first AP route call creates the db file on demand", async () => {
    expect(existsSync(dbPath)).toBe(false);
    const res = await fetchHandler(devRequest("/api/ap/rows"));
    expect(res.status).toBe(200);
    expect(existsSync(dbPath)).toBe(true);
  });
});

describe("AP register: row validation and CRUD (no engine involved)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ap-crud-test-"));
    process.env.AP_DB_PATH = join(tmpDir, "ap.db");
    apStore._resetForTests();
  });

  afterEach(() => {
    resetAuthEnv();
    apStore._resetForTests();
    delete process.env.AP_DB_PATH;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function post(body: unknown) {
    return devRequest("/api/ap/rows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("400s on a missing creditor", async () => {
    const res = await fetchHandler(post(baseApRowBody({ creditor: "" })));
    expect(res.status).toBe(400);
  });

  test("400s on a missing item", async () => {
    const res = await fetchHandler(post(baseApRowBody({ item: "" })));
    expect(res.status).toBe(400);
  });

  test("400s on a non-positive amount", async () => {
    const res = await fetchHandler(post(baseApRowBody({ amountSatang: 0 })));
    expect(res.status).toBe(400);
  });

  test("400s on an unknown category code", async () => {
    const res = await fetchHandler(post(baseApRowBody({ categoryCode: "not-a-real-code" })));
    expect(res.status).toBe(400);
  });

  test("accepts a blank/absent due date — unlike ordinary expenses, unbounded and optional", async () => {
    const res = await fetchHandler(post(baseApRowBody({ dueDate: null })));
    expect(res.status).toBe(201);
  });

  test("accepts a PAST due date with no rejection (carried-forward bills are the norm)", async () => {
    const res = await fetchHandler(post(baseApRowBody({ dueDate: "2020-01-01" })));
    expect(res.status).toBe(201);
  });

  test("400s when a discount would push ยอดค้างชำระ negative on create", async () => {
    const res = await fetchHandler(post(baseApRowBody({ amountSatang: 1_000, discountSatang: 5_000 })));
    expect(res.status).toBe(400);
  });

  test("L6 fix: 400s a due date with an out-of-sane-range year (the workbook really has a 1969 typo)", async () => {
    const res = await fetchHandler(post(baseApRowBody({ dueDate: "1969-06-15" })));
    expect(res.status).toBe(400);
  });

  test("L6 fix: 400s a due date past year 2100 too", async () => {
    const res = await fetchHandler(post(baseApRowBody({ dueDate: "2101-01-01" })));
    expect(res.status).toBe(400);
  });

  test("L6 fix: the boundary years 2000 and 2100 are both accepted", async () => {
    const res2000 = await fetchHandler(post(baseApRowBody({ dueDate: "2000-01-01" })));
    expect(res2000.status).toBe(201);
    const res2100 = await fetchHandler(post(baseApRowBody({ creditor: "Other Co", dueDate: "2100-12-31" })));
    expect(res2100.status).toBe(201);
  });

  test("H3 fix: a discount equal to the gross settles the row at creation with a non-null settledAt (credit-note case, zero payments)", async () => {
    const createRes = await fetchHandler(post(baseApRowBody({ amountSatang: 5_000, discountSatang: 5_000 })));
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    const listRes = await fetchHandler(devRequest("/api/ap/rows?f=all"));
    const body = (await listRes.json()) as { rows: { id: string; outstandingSatang: number; settledAt: string | null }[] };
    const row = body.rows.find((r) => r.id === id)!;
    expect(row.outstandingSatang).toBe(0);
    expect(row.settledAt).not.toBeNull();
  });

  test("M5 fix: POST /api/ap/rows 415s a non-JSON content-type", async () => {
    const res = await fetchHandler(
      devRequest("/api/ap/rows", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(baseApRowBody()),
      }),
    );
    expect(res.status).toBe(415);
  });

  test("M5 fix: PATCH /api/ap/rows/:id 415s a non-JSON content-type", async () => {
    const res = await fetchHandler(
      devRequest("/api/ap/rows/does-not-matter", {
        method: "PATCH",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(baseApRowBody()),
      }),
    );
    expect(res.status).toBe(415);
  });

  test("a valid row creates, then round-trips through GET /api/ap/rows", async () => {
    const createRes = await fetchHandler(post(baseApRowBody()));
    expect(createRes.status).toBe(201);
    const { id } = (await createRes.json()) as { id: string };

    const listRes = await fetchHandler(devRequest("/api/ap/rows?f=all"));
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { rows: { id: string; outstandingSatang: number }[] };
    const row = body.rows.find((r) => r.id === id);
    expect(row).toBeDefined();
    expect(row!.outstandingSatang).toBe(10_000);
  });

  test("PATCH rejects an edit that would push ยอดค้างชำระ negative given existing payments", async () => {
    const createRes = await fetchHandler(post(baseApRowBody({ amountSatang: 10_000 })));
    const { id } = (await createRes.json()) as { id: string };
    apStore.addApPayment(id, {
      date: todayBangkok(),
      amountSatang: 8_000,
      paymentMethod: "cash",
      kind: "deposit",
      installmentNumber: null,
      payerEmail: "tester@thehfhotel.org",
      transactionId: "1",
    });
    // Editing amountSatang down to 5,000 while 8,000 is already paid would
    // make outstanding negative (5,000 - 8,000 = -3,000).
    const patchRes = await fetchHandler(
      devRequest(`/api/ap/rows/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(baseApRowBody({ amountSatang: 5_000 })),
      }),
    );
    expect(patchRes.status).toBe(400);
  });

  test("PATCH 404s on an unknown row id", async () => {
    const res = await fetchHandler(
      devRequest("/api/ap/rows/does-not-exist", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(baseApRowBody()),
      }),
    );
    expect(res.status).toBe(404);
  });

  describe("delete rules — zero-payment rows only (spec §6)", () => {
    test("deletes a row with zero payments", async () => {
      const createRes = await fetchHandler(post(baseApRowBody()));
      const { id } = (await createRes.json()) as { id: string };
      const deleteRes = await fetchHandler(devRequest(`/api/ap/rows/${id}`, { method: "DELETE" }));
      expect(deleteRes.status).toBe(204);
      expect(apStore.getApRow(id)).toBeNull();
    });

    test("409s has_payments for a row with >= 1 payment, and does not delete it", async () => {
      const createRes = await fetchHandler(post(baseApRowBody()));
      const { id } = (await createRes.json()) as { id: string };
      apStore.addApPayment(id, {
        date: todayBangkok(),
        amountSatang: 1_000,
        paymentMethod: "cash",
        kind: "deposit",
        installmentNumber: null,
        payerEmail: "tester@thehfhotel.org",
        transactionId: "1",
      });
      const deleteRes = await fetchHandler(devRequest(`/api/ap/rows/${id}`, { method: "DELETE" }));
      expect(deleteRes.status).toBe(409);
      expect(await deleteRes.json()).toEqual({ error: "has_payments" });
      expect(apStore.getApRow(id)).not.toBeNull();
    });

    test("404s deleting an unknown row id", async () => {
      const res = await fetchHandler(devRequest("/api/ap/rows/does-not-exist", { method: "DELETE" }));
      expect(res.status).toBe(404);
    });
  });
});

describe("AP register: payment posting (mocked engine HTTP)", () => {
  // One primary/secondary pair matching src/shared/categories.ts's
  // "commission-booking" leaf (no `building`), and the two seeded accounts —
  // same shape convention as engine.test.ts's fixtures.
  const CATEGORIES_RESPONSE = {
    success: true,
    result: {
      "2": [{ id: "500", name: "ค่าคอมมิชชั่น BOOKING", subCategories: [{ id: "501", name: "ค่าคอมมิชชั่น BOOKING" }] }],
    },
  };
  const ACCOUNTS_RESPONSE = {
    success: true,
    result: [
      { id: "1", name: "เงินสด", category: 1 },
      { id: "2", name: "ธนาคาร", category: 2 },
    ],
  };

  let tmpDir: string;
  const calls: { url: string; body: unknown }[] = [];
  const originalFetch = global.fetch;
  let nextTransactionId = 900;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ap-payment-test-"));
    process.env.AP_DB_PATH = join(tmpDir, "ap.db");
    process.env.ENGINE_API_TOKEN = "test-token";
    apStore._resetForTests();
    engineInternal.resetCaches();
    calls.length = 0;
    nextTransactionId = 900;

    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url: href, body });

      if (href.includes("/transaction/categories/list.json")) {
        return new Response(JSON.stringify(CATEGORIES_RESPONSE));
      }
      if (href.includes("/accounts/list.json")) {
        return new Response(JSON.stringify(ACCOUNTS_RESPONSE));
      }
      if (href.includes("/transaction/tags/list.json")) {
        return new Response(JSON.stringify({ success: true, result: [] }));
      }
      if (href.includes("/transaction/tags/add.json")) {
        return new Response(JSON.stringify({ success: true, result: { id: "700", name: body.name } }));
      }
      if (href.includes("/transactions/add.json")) {
        const id = String(nextTransactionId++);
        return new Response(JSON.stringify({ success: true, result: { id } }));
      }
      throw new Error(`unexpected engine call in test: ${href}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetAuthEnv();
    apStore._resetForTests();
    delete process.env.AP_DB_PATH;
    engineInternal.resetCaches();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createRow(overrides: Record<string, unknown> = {}): string {
    return apStore.createApRow(
      {
        creditor: "Booking.com",
        item: "ค่าคอมมิชชั่น ก.ค. 69",
        amountSatang: 10_000,
        vatSatang: null,
        whtSatang: null,
        discountSatang: 0,
        dueDate: null,
        entity: "HF",
        categoryCode: "commission-booking",
        note: "",
        ...overrides,
      } as never,
      "tester@thehfhotel.org",
    );
  }

  function postPayment(rowId: string, body: unknown) {
    return devRequest(`/api/ap/rows/${rowId}/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  test("posts an engine transaction and records the payment locally, reducing outstanding", async () => {
    const rowId = createRow();
    const res = await fetchHandler(
      postPayment(rowId, { date: todayBangkok(), amountSatang: 4_000, paymentMethod: "cash" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { paymentId: string; transactionId: string };
    expect(body.paymentId).toBeTruthy();
    expect(body.transactionId).toBeTruthy();

    const row = apStore.getApRow(rowId)!;
    expect(row.outstandingSatang).toBe(6_000);
    expect(row.payments.length).toBe(1);
    expect(row.payments[0]!.kind).toBe("deposit");
    expect(row.payments[0]!.transactionId).toBe(body.transactionId);

    const addTxnCall = calls.find((c) => c.url.includes("/transactions/add.json"));
    expect((addTxnCall?.body as { comment: string }).comment).toContain("[hf:by=tester@thehfhotel.org]");
  });

  test("a payment that pays the full outstanding balance settles the row (kind=full)", async () => {
    const rowId = createRow();
    const res = await fetchHandler(
      postPayment(rowId, { date: todayBangkok(), amountSatang: 10_000, paymentMethod: "bank" }),
    );
    expect(res.status).toBe(201);
    const row = apStore.getApRow(rowId)!;
    expect(row.outstandingSatang).toBe(0);
    expect(row.payments[0]!.kind).toBe("full");
    expect(row.settledAt).toBe(todayBangkok());
  });

  test("400s when the payment amount exceeds the outstanding balance", async () => {
    const rowId = createRow();
    const res = await fetchHandler(
      postPayment(rowId, { date: todayBangkok(), amountSatang: 999_999, paymentMethod: "cash" }),
    );
    expect(res.status).toBe(400);
    expect(calls.some((c) => c.url.includes("/transactions/add.json"))).toBe(false);
  });

  test("400s with the same 'current month' error a back-dated payment would need to map to PAST_MONTH_LOCK", async () => {
    const rowId = createRow();
    const res = await fetchHandler(
      postPayment(rowId, { date: pastMonthDate(), amountSatang: 1_000, paymentMethod: "cash" }),
    );
    expect(res.status).toBe(400);
    const responseBody = (await res.json()) as { error: string };
    expect(responseBody.error).toBe("date must be in the current month");
    expect(calls.some((c) => c.url.includes("/transactions/add.json"))).toBe(false);
  });

  test("404s posting a payment against an unknown row id", async () => {
    const res = await fetchHandler(
      postPayment("does-not-exist", { date: todayBangkok(), amountSatang: 1_000, paymentMethod: "cash" }),
    );
    expect(res.status).toBe(404);
  });

  test("M5 fix: 415s a non-JSON content-type before touching the engine or the row", async () => {
    const rowId = createRow();
    const res = await fetchHandler(
      devRequest(`/api/ap/rows/${rowId}/payments`, {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ date: todayBangkok(), amountSatang: 1_000, paymentMethod: "cash" }),
      }),
    );
    expect(res.status).toBe(415);
    expect(calls.length).toBe(0);
  });

  test("H1 fix: two overlapping payment requests against the same row — exactly one succeeds, outstanding never goes negative", async () => {
    const rowId = createRow({ amountSatang: 10_000 });
    const [resA, resB] = await Promise.all([
      fetchHandler(postPayment(rowId, { date: todayBangkok(), amountSatang: 6_000, paymentMethod: "cash" })),
      fetchHandler(postPayment(rowId, { date: todayBangkok(), amountSatang: 6_000, paymentMethod: "bank" })),
    ]);
    const statuses = [resA.status, resB.status].sort((a, b) => a - b);
    // Exactly one succeeds (201), the other is correctly rejected (400,
    // "amount exceeds outstanding") once it re-reads the balance the first
    // one already spent — never both succeeding (which would double-book
    // the engine) and never both failing.
    expect(statuses).toEqual([201, 400]);

    const row = apStore.getApRow(rowId)!;
    expect(row.payments.length).toBe(1);
    expect(row.outstandingSatang).toBe(4_000);
    expect(row.outstandingSatang).toBeGreaterThanOrEqual(0);

    const addCalls = calls.filter((c) => c.url.includes("/transactions/add.json"));
    expect(addCalls.length).toBe(1);
  });

  test("H4a fix: a local insert failure AFTER the engine already posted returns 500 ap_store_error (not 502), and compensates by deleting the ledger transaction", async () => {
    const rowId = createRow();
    // A path whose "directory" component is actually a plain FILE is a
    // reliable, permission-independent way to make bun:sqlite's Database
    // constructor throw (apStore.ts's openDb() only mkdir's a MISSING
    // directory; it never touches one that already exists as a file) —
    // unlike pointing at a root-owned path, this doesn't depend on which
    // user runs the test suite.
    const brokenDir = join(tmpDir, "not-a-directory");
    writeFileSync(brokenDir, "");
    const originalDbPath = process.env.AP_DB_PATH!;
    let deleteCalled = false;

    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      if (href.includes("/transaction/categories/list.json")) return new Response(JSON.stringify(CATEGORIES_RESPONSE));
      if (href.includes("/accounts/list.json")) return new Response(JSON.stringify(ACCOUNTS_RESPONSE));
      if (href.includes("/transaction/tags/list.json")) return new Response(JSON.stringify({ success: true, result: [] }));
      if (href.includes("/transaction/tags/add.json")) {
        return new Response(JSON.stringify({ success: true, result: { id: "700", name: body.name } }));
      }
      if (href.includes("/transactions/add.json")) {
        const id = String(nextTransactionId++);
        // Force the NEXT apStore call (addApPayment) to fail by pointing
        // AP_DB_PATH at the broken path above, closing the cached handle so
        // the route's next getDb() call re-opens (and fails) at it.
        apStore._resetForTests();
        process.env.AP_DB_PATH = join(brokenDir, "ap.db");
        return new Response(JSON.stringify({ success: true, result: { id } }));
      }
      if (href.includes("/transactions/delete.json")) {
        deleteCalled = true;
        // Restore the real path before the route's compensating-delete
        // catch block finishes, so afterEach's cleanup (and the assertions
        // below) reach the real temp db again.
        process.env.AP_DB_PATH = originalDbPath;
        apStore._resetForTests();
        return new Response(JSON.stringify({ success: true }));
      }
      throw new Error(`unexpected engine call in test: ${href}`);
    }) as typeof fetch;

    const res = await fetchHandler(
      postPayment(rowId, { date: todayBangkok(), amountSatang: 4_000, paymentMethod: "cash" }),
    );
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "ap_store_error" });
    expect(deleteCalled).toBe(true);

    const row = apStore.getApRow(rowId)!;
    expect(row.payments.length).toBe(0);
    expect(row.outstandingSatang).toBe(10_000);
  });

  test("L3 fix: a long creditor/item truncates but keeps the payment-kind marker intact", async () => {
    const rowId = createRow({ creditor: "x".repeat(200), item: "y".repeat(200) });
    // First payment (deposit), so the SECOND is an "installment" — the kind
    // that carries the " (งวดที่ N)" marker this fix protects.
    const firstRes = await fetchHandler(
      postPayment(rowId, { date: todayBangkok(), amountSatang: 1_000, paymentMethod: "cash" }),
    );
    expect(firstRes.status).toBe(201);

    const longEmail = `${"a".repeat(50)}@thehfhotel.org`;
    const secondRes = await fetchHandler(
      devRequestAs(longEmail, `/api/ap/rows/${rowId}/payments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: todayBangkok(), amountSatang: 1_000, paymentMethod: "cash" }),
      }),
    );
    expect(secondRes.status).toBe(201);

    const addCalls = calls.filter((c) => c.url.includes("/transactions/add.json"));
    const secondAddCall = addCalls[addCalls.length - 1];
    const comment = (secondAddCall?.body as { comment: string }).comment;
    expect(comment).toContain("(งวดที่ 1)");
  });
});

describe("AP register: payment undo (mocked engine HTTP)", () => {
  let tmpDir: string;
  const calls: { url: string; body: unknown }[] = [];
  const originalFetch = global.fetch;

  /** Controls what GET /transactions/get.json?id=<transactionId> reports as
   * `time`, so the route's own current-month lock check can be driven to
   * either branch deterministically. */
  let transactionTimesById: Record<string, number> = {};

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "ap-undo-test-"));
    process.env.AP_DB_PATH = join(tmpDir, "ap.db");
    process.env.ENGINE_API_TOKEN = "test-token";
    apStore._resetForTests();
    engineInternal.resetCaches();
    calls.length = 0;
    transactionTimesById = {};

    global.fetch = (async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      calls.push({ url: href, body });

      if (href.includes("/transactions/get.json")) {
        const id = new URL(href).searchParams.get("id")!;
        return new Response(JSON.stringify({ success: true, result: { id, time: transactionTimesById[id] } }));
      }
      if (href.includes("/transactions/delete.json")) {
        return new Response(JSON.stringify({ success: true }));
      }
      throw new Error(`unexpected engine call in test: ${href}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetAuthEnv();
    apStore._resetForTests();
    delete process.env.AP_DB_PATH;
    engineInternal.resetCaches();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function seedRowWithPayment(transactionId: string): { rowId: string; paymentId: string } {
    const rowId = apStore.createApRow(
      {
        creditor: "Booking.com",
        item: "ค่าคอมมิชชั่น ก.ค. 69",
        amountSatang: 10_000,
        vatSatang: null,
        whtSatang: null,
        discountSatang: 0,
        dueDate: null,
        entity: "HF",
        categoryCode: "commission-booking",
        note: "",
      },
      "tester@thehfhotel.org",
    );
    const paymentId = apStore.addApPayment(rowId, {
      date: todayBangkok(),
      amountSatang: 4_000,
      paymentMethod: "cash",
      kind: "deposit",
      installmentNumber: null,
      payerEmail: "tester@thehfhotel.org",
      transactionId,
    });
    return { rowId, paymentId };
  }

  test("deletes exactly the linked ledger transaction and the payment record when the transaction is in the current month", async () => {
    const { rowId, paymentId } = seedRowWithPayment("500");
    transactionTimesById["500"] = buildTransactionUnixTimeSeconds(todayBangkok());

    const res = await fetchHandler(
      devRequest(`/api/ap/rows/${rowId}/payments/${paymentId}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(204);

    const deleteCall = calls.find((c) => c.url.includes("/transactions/delete.json"));
    expect((deleteCall?.body as { id: string }).id).toBe("500");
    expect(apStore.getApPayment(rowId, paymentId)).toBeNull();
    expect(apStore.getApRow(rowId)!.outstandingSatang).toBe(10_000);
  });

  test("blocks undo with 409 ledger_month_locked when the transaction fell into a closed past month, leaving the payment intact", async () => {
    const { rowId, paymentId } = seedRowWithPayment("501");
    transactionTimesById["501"] = buildTransactionUnixTimeSeconds(pastMonthDate());

    const res = await fetchHandler(
      devRequest(`/api/ap/rows/${rowId}/payments/${paymentId}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "ledger_month_locked" });
    expect(calls.some((c) => c.url.includes("/transactions/delete.json"))).toBe(false);
    expect(apStore.getApPayment(rowId, paymentId)).not.toBeNull();
  });

  test("404s undoing a payment id that doesn't belong to the given row", async () => {
    const { paymentId } = seedRowWithPayment("502");
    const otherRowId = apStore.createApRow(
      {
        creditor: "การไฟฟ้า",
        item: "ค่าไฟ",
        amountSatang: 5_000,
        vatSatang: null,
        whtSatang: null,
        discountSatang: 0,
        dueDate: null,
        entity: "HF",
        categoryCode: "other",
        note: "",
      },
      "tester@thehfhotel.org",
    );
    const res = await fetchHandler(
      devRequest(`/api/ap/rows/${otherRowId}/payments/${paymentId}`, { method: "DELETE" }),
    );
    expect(res.status).toBe(404);
  });

  test("H2b/L4 fix: undoing a payment whose linked transaction is already gone from the engine still succeeds — deletes the local record and returns 204", async () => {
    const { rowId, paymentId } = seedRowWithPayment("999");
    // Simulates a DANGLING local payment (H2b's own scenario — e.g. a
    // previous undo's compensating delete already ran, or a manual delete
    // via ezBookkeeping's own UI): get.json reports success:false rather
    // than a real transaction, which src/server/engine.ts's
    // getEngineTransaction now surfaces as EngineTransactionNotFoundError.
    global.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/transactions/get.json")) {
        return new Response(JSON.stringify({ success: false, errorMessage: "transaction not found" }));
      }
      throw new Error(`unexpected engine call in test: ${href}`);
    }) as typeof fetch;

    const res = await fetchHandler(devRequest(`/api/ap/rows/${rowId}/payments/${paymentId}`, { method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(apStore.getApPayment(rowId, paymentId)).toBeNull();
    expect(apStore.getApRow(rowId)!.outstandingSatang).toBe(10_000);
  });

  test("L4 fix: the engine's own delete call reporting not-found during undo is not an error — still 204s and removes the local payment", async () => {
    const { rowId, paymentId } = seedRowWithPayment("998");
    transactionTimesById["998"] = buildTransactionUnixTimeSeconds(todayBangkok());

    global.fetch = (async (url: string | URL) => {
      const href = String(url);
      if (href.includes("/transactions/get.json")) {
        const id = new URL(href).searchParams.get("id")!;
        return new Response(JSON.stringify({ success: true, result: { id, time: transactionTimesById[id] } }));
      }
      if (href.includes("/transactions/delete.json")) {
        // The double-undo race (L4): by the time this call runs, the
        // transaction is already gone (e.g. a racing request's delete beat
        // this one to it) — success:false here must not fail the whole undo.
        return new Response(JSON.stringify({ success: false, errorMessage: "not found" }));
      }
      throw new Error(`unexpected engine call in test: ${href}`);
    }) as typeof fetch;

    const res = await fetchHandler(devRequest(`/api/ap/rows/${rowId}/payments/${paymentId}`, { method: "DELETE" }));
    expect(res.status).toBe(204);
    expect(apStore.getApPayment(rowId, paymentId)).toBeNull();
  });
});
