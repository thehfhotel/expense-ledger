import { describe, expect, test } from "bun:test";

import categoriesData from "./categories.json";
import type { CategoriesConfig } from "./lib/categories-config.ts";
import { findDailySheetName, resolveColumnCategory } from "./lib/mapping.ts";

const realCategories = categoriesData as CategoriesConfig;

const fixtureCategories: CategoriesConfig = {
  primaries: [
    { code: "breakfast", label: "ค่าอาหารเช้า", icon: "1", color: "ff9500", secondaries: ["ค่าอาหารเช้า"] },
    { code: "water-utility", label: "ค่าน้ำประปา", icon: "270", color: "2196f3", secondaries: ["สายชล", "Hop inn 47", "HF Ville"] },
  ],
  accounts: [],
};

describe("resolveColumnCategory", () => {
  test("resolves a single-secondary column (E -> breakfast)", () => {
    expect(resolveColumnCategory("E", fixtureCategories)).toEqual({
      code: "breakfast",
      label: "ค่าอาหารเช้า",
      secondaryLabel: "ค่าอาหารเช้า",
    });
  });

  test("resolves each column of a multi-secondary primary to a distinct secondary (I/J/K -> water-utility)", () => {
    expect(resolveColumnCategory("I", fixtureCategories)?.secondaryLabel).toBe("สายชล");
    expect(resolveColumnCategory("J", fixtureCategories)?.secondaryLabel).toBe("Hop inn 47");
    expect(resolveColumnCategory("K", fixtureCategories)?.secondaryLabel).toBe("HF Ville");
  });

  test("returns undefined for a column outside the expense mapping (revenue/date/note columns)", () => {
    expect(resolveColumnCategory("A", fixtureCategories)).toBeUndefined();
    expect(resolveColumnCategory("B", fixtureCategories)).toBeUndefined();
    expect(resolveColumnCategory("Z", fixtureCategories)).toBeUndefined();
  });

  test("returns undefined when the config is missing the primary a column expects", () => {
    const missingPrimary: CategoriesConfig = { primaries: [], accounts: [] };
    expect(resolveColumnCategory("E", missingPrimary)).toBeUndefined();
  });

  test("returns undefined when the config's primary doesn't have enough secondaries", () => {
    const shortSecondaries: CategoriesConfig = {
      primaries: [{ code: "water-utility", label: "ค่าน้ำประปา", icon: "270", color: "2196f3", secondaries: ["สายชล"] }],
      accounts: [],
    };
    expect(resolveColumnCategory("J", shortSecondaries)).toBeUndefined(); // secondaryIndex 1, only 1 secondary present
  });

  test("resolves all 21 expense columns (E-Y) against the real canonical categories.json", () => {
    const columns = "EFGHIJKLMNOPQRSTUVWXY".split("");
    for (const column of columns) {
      const resolved = resolveColumnCategory(column, realCategories);
      expect(resolved, `column ${column} should resolve`).toBeDefined();
    }
  });
});

describe("findDailySheetName", () => {
  test("picks the sheet ending in \"HF\" out of the real workbook's sheet list", () => {
    const sheetNames = ["ก.ค.-69- HF", "ก.ค.69 HF Ville", "งบ-ก.ค.2569", "งบต.ค.2568 HF Ville", "ค่าใช้จ่าย"];
    expect(findDailySheetName(sheetNames)).toBe("ก.ค.-69- HF");
  });

  test("throws when no candidate matches", () => {
    expect(() => findDailySheetName(["งบ-ก.ค.2569", "ค่าใช้จ่าย"])).toThrow();
  });

  test("throws when more than one candidate matches", () => {
    expect(() => findDailySheetName(["ก.ค.-69- HF", "ส.ค.-69- HF"])).toThrow();
  });
});
