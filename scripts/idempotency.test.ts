import { describe, expect, test } from "bun:test";

import { findTaggedTransactionIds } from "./lib/idempotency.ts";

describe("findTaggedTransactionIds", () => {
  test("returns ids of transactions carrying the given tag", () => {
    const txns = [
      { id: "1", tagIds: ["import:2026-07"] },
      { id: "2", tagIds: ["other-tag"] },
      { id: "3", tagIds: ["import:2026-07", "other-tag"] },
    ];

    expect(findTaggedTransactionIds(txns, "import:2026-07")).toEqual(["1", "3"]);
  });

  test("returns [] when nothing carries the tag", () => {
    const txns = [{ id: "1", tagIds: ["other-tag"] }];
    expect(findTaggedTransactionIds(txns, "import:2026-07")).toEqual([]);
  });

  test("returns [] for an empty transaction list", () => {
    expect(findTaggedTransactionIds([], "import:2026-07")).toEqual([]);
  });

  test("resolves the tag by exact id, not by substring", () => {
    const txns = [{ id: "1", tagIds: ["import:2026-070"] }]; // looks similar, not equal
    expect(findTaggedTransactionIds(txns, "import:2026-07")).toEqual([]);
  });
});
