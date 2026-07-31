import { describe, expect, test } from "bun:test";

import { buildReconciliation, reconciliationPassed } from "./lib/reconcile.ts";

describe("buildReconciliation", () => {
  test("reports ok when workbook (baht) and engine (satang) totals agree", () => {
    const workbook = new Map([["breakfast::x", 20760.75]]);
    const engine = new Map([["breakfast::x", 2076075]]); // 20760.75 * 100
    const rows = buildReconciliation(workbook, engine, new Map([["breakfast::x", "breakfast"]]));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, diffMinor: 0 });
  });

  test("reports a nonzero diff when totals disagree", () => {
    const workbook = new Map([["other::x", 152319]]);
    const engine = new Map([["other::x", 15231800]]); // 1 baht short of matching (should be 15231900)
    const rows = buildReconciliation(workbook, engine, new Map());

    expect(rows[0]!.ok).toBe(false);
    expect(rows[0]!.diffMinor).toBe(-100); // short by 1.00 baht = 100 satang
  });

  test("rounds workbook major-unit totals before comparing, avoiding float noise", () => {
    // 0.1 + 0.2 !== 0.3 in IEEE754 - make sure we don't false-positive on that.
    const workbook = new Map([["k", 0.1 + 0.2]]);
    const engine = new Map([["k", 30]]); // 0.30 baht = 30 satang
    const rows = buildReconciliation(workbook, engine, new Map());
    expect(rows[0]!.ok).toBe(true);
  });

  test("includes a category present only on one side (missing from the other)", () => {
    const workbook = new Map([["only-in-workbook", 100]]);
    const engine = new Map<string, number>();
    const rows = buildReconciliation(workbook, engine, new Map());

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ categoryKey: "only-in-workbook", engineTotalMinor: 0, diffMinor: -10000, ok: false });
  });

  test("sorts rows by label", () => {
    const workbook = new Map([
      ["b", 1],
      ["a", 1],
    ]);
    const engine = new Map([
      ["b", 100],
      ["a", 100],
    ]);
    const labels = new Map([
      ["b", "Zebra"],
      ["a", "Alpha"],
    ]);
    const rows = buildReconciliation(workbook, engine, labels);
    expect(rows.map((r) => r.label)).toEqual(["Alpha", "Zebra"]);
  });
});

describe("reconciliationPassed", () => {
  test("true only when every row is ok", () => {
    expect(reconciliationPassed([{ categoryKey: "a", label: "a", workbookTotalMajor: 1, engineTotalMinor: 100, diffMinor: 0, ok: true }])).toBe(
      true,
    );
    expect(
      reconciliationPassed([
        { categoryKey: "a", label: "a", workbookTotalMajor: 1, engineTotalMinor: 100, diffMinor: 0, ok: true },
        { categoryKey: "b", label: "b", workbookTotalMajor: 1, engineTotalMinor: 90, diffMinor: -10, ok: false },
      ]),
    ).toBe(false);
    expect(reconciliationPassed([])).toBe(true);
  });
});
