// Server route tests. Mirrors income-ledger's src/server/server.test.ts
// pattern: drive the exported request handler directly, no live socket
// needed. NODE_ENV/DEV_USER are toggled per-test (access.ts reads them at
// call time, not at import time) to exercise both the JWT gate and the
// dev-mode bypass without a real Cloudflare Access JWT.

import { afterEach, describe, expect, test } from "bun:test";
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
