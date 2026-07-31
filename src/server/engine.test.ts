// H2 regression coverage: modify.json is a full overwrite (see
// transactionBuilder.ts), so any single-field edit or photo attach/detach
// that doesn't resend the transaction's EXISTING tagIds silently wipes them
// — including scripts/import-workbook.ts's `import:<YYYY-MM>` idempotency
// tag, which would then double-count that row on a later `--force`
// re-import. These tests mock the engine's HTTP surface directly (global
// fetch) and assert the modify.json request body actually carries the
// existing tagIds through, for each of the three call sites that fetch an
// existing transaction before resending it.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  attachExpensePhoto,
  createApPaymentTransaction,
  detachExpensePhoto,
  modifyExpenseTransaction,
  _internal,
} from "./engine.ts";

// One primary/secondary pair matching src/shared/categories.ts's "other"
// leaf (no `building`, so the secondary carries the same label) — the only
// category these tests need resolved.
const CATEGORIES_RESPONSE = {
  success: true,
  result: {
    "2": [
      {
        id: "500",
        name: "ค่าใช้จ่ายอื่นๆ",
        subCategories: [{ id: "501", name: "ค่าใช้จ่ายอื่นๆ" }],
      },
    ],
  },
};

const ACCOUNTS_RESPONSE = {
  success: true,
  result: [
    { id: "1", name: "เงินสด", category: 1 },
    { id: "2", name: "ธนาคาร", category: 2 },
  ],
};

// The transaction every test fetches via GET /transactions/get.json before
// resending it — carries one existing picture and one existing tag (the
// stand-in for import-workbook.ts's import:<YYYY-MM> tag).
const EXISTING_TRANSACTION = {
  id: "123",
  categoryId: "501",
  time: 1752566400,
  sourceAccountId: "1",
  sourceAmount: 5000,
  comment: "ค่าเช่ารถ\n[hf:by=first@thehfhotel.org]",
  pictureIds: ["55"],
  tagIds: ["99"],
};

describe("tag preservation across modify / photo attach-detach (H2)", () => {
  const calls: { url: string; body: unknown }[] = [];
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.ENGINE_API_TOKEN = "test-token";
    calls.length = 0;
    _internal.resetCaches();
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
      if (href.includes("/transactions/get.json")) {
        return new Response(JSON.stringify({ success: true, result: EXISTING_TRANSACTION }));
      }
      if (href.includes("/transactions/modify.json")) {
        return new Response(JSON.stringify({ success: true }));
      }
      if (href.includes("/transaction/pictures/upload.json")) {
        return new Response(
          JSON.stringify({ success: true, result: { pictureId: "77", originalUrl: "http://engine/77.jpg" } }),
        );
      }
      throw new Error(`unexpected engine call in test: ${href}`);
    }) as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.ENGINE_API_TOKEN;
    _internal.resetCaches();
  });

  test("modifyExpenseTransaction resends the existing tagIds instead of wiping them", async () => {
    await modifyExpenseTransaction(
      "123",
      { date: "2026-07-15", amountSatang: 6000, categoryCode: "other", paymentMethod: "cash", comment: "updated" },
      "second@thehfhotel.org",
    );
    const modifyCall = calls.find((c) => c.url.includes("/transactions/modify.json"));
    expect((modifyCall?.body as { tagIds: string[] } | undefined)?.tagIds).toEqual(["99"]);
  });

  test("attachExpensePhoto resends the existing tagIds instead of wiping them", async () => {
    await attachExpensePhoto("123", new Blob(["fake-image-bytes"]), "receipt.jpg");
    const modifyCall = calls.find((c) => c.url.includes("/transactions/modify.json"));
    expect((modifyCall?.body as { tagIds: string[] } | undefined)?.tagIds).toEqual(["99"]);
  });

  test("detachExpensePhoto resends the existing tagIds instead of wiping them", async () => {
    await detachExpensePhoto("123", "55");
    const modifyCall = calls.find((c) => c.url.includes("/transactions/modify.json"));
    expect((modifyCall?.body as { tagIds: string[] } | undefined)?.tagIds).toEqual(["99"]);
  });
});

describe("createApPaymentTransaction — AP register payment posting (orchestrator ruling #3)", () => {
  const calls: { url: string; body: unknown }[] = [];
  const originalFetch = global.fetch;

  function install(tagsListResult: { id: string; name: string }[]) {
    calls.length = 0;
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
        return new Response(JSON.stringify({ success: true, result: tagsListResult }));
      }
      if (href.includes("/transaction/tags/add.json")) {
        return new Response(JSON.stringify({ success: true, result: { id: "new-tag-id", name: body.name } }));
      }
      if (href.includes("/transactions/add.json")) {
        return new Response(JSON.stringify({ success: true, result: { id: "999" } }));
      }
      throw new Error(`unexpected engine call in test: ${href}`);
    }) as typeof fetch;
  }

  beforeEach(() => {
    process.env.ENGINE_API_TOKEN = "test-token";
    _internal.resetCaches();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.ENGINE_API_TOKEN;
    _internal.resetCaches();
  });

  test("resolves the AP row's category to the same engine id createExpenseTransaction would use", async () => {
    install([]);
    await createApPaymentTransaction({
      date: "2026-07-15",
      amountSatang: 5_000,
      categoryCode: "other",
      paymentMethod: "cash",
      comment: "Booking.com - ค่าคอมมิชชั่น",
      email: "clerk@thehfhotel.org",
      apRowId: "row-1",
    });
    const addTxnCall = calls.find((c) => c.url.includes("/transactions/add.json"));
    expect((addTxnCall?.body as { categoryId: string }).categoryId).toBe("501");
    expect((addTxnCall?.body as { sourceAccountId: string }).sourceAccountId).toBe("1");
  });

  test("creates the ap:<rowId> tag on demand when it doesn't exist yet, and posts with that tag id", async () => {
    install([]); // no existing tags
    const id = await createApPaymentTransaction({
      date: "2026-07-15",
      amountSatang: 5_000,
      categoryCode: "other",
      paymentMethod: "cash",
      comment: "Booking.com - ค่าคอมมิชชั่น",
      email: "clerk@thehfhotel.org",
      apRowId: "row-1",
    });
    expect(id).toBe("999");
    const addTagCall = calls.find((c) => c.url.includes("/transaction/tags/add.json"));
    expect((addTagCall?.body as { name: string }).name).toBe("ap:row-1");
    const addTxnCall = calls.find((c) => c.url.includes("/transactions/add.json"));
    expect((addTxnCall?.body as { tagIds: string[] }).tagIds).toEqual(["new-tag-id"]);
  });

  test("reuses an existing ap:<rowId> tag instead of creating a duplicate", async () => {
    install([{ id: "existing-tag-id", name: "ap:row-2" }]);
    await createApPaymentTransaction({
      date: "2026-07-15",
      amountSatang: 5_000,
      categoryCode: "other",
      paymentMethod: "cash",
      comment: "หจก.บุญดี - ค่าซ่อมแซม",
      email: "clerk@thehfhotel.org",
      apRowId: "row-2",
    });
    expect(calls.some((c) => c.url.includes("/transaction/tags/add.json"))).toBe(false);
    const addTxnCall = calls.find((c) => c.url.includes("/transactions/add.json"));
    expect((addTxnCall?.body as { tagIds: string[] }).tagIds).toEqual(["existing-tag-id"]);
  });

  test("appends the caller's attribution token to the posted comment, same contract as ordinary expenses", async () => {
    install([]);
    await createApPaymentTransaction({
      date: "2026-07-15",
      amountSatang: 5_000,
      categoryCode: "other",
      paymentMethod: "cash",
      comment: "Booking.com - ค่าคอมมิชชั่น (มัดจำ)",
      email: "clerk@thehfhotel.org",
      apRowId: "row-1",
    });
    const addTxnCall = calls.find((c) => c.url.includes("/transactions/add.json"));
    expect((addTxnCall?.body as { comment: string }).comment).toBe(
      "Booking.com - ค่าคอมมิชชั่น (มัดจำ)\n[hf:by=clerk@thehfhotel.org]",
    );
  });
});
