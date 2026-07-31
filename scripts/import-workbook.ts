#!/usr/bin/env bun
// Imports one month's "รายงานรายได้-รายจ่าย" workbook into the ezBookkeeping
// engine as expense transactions. Revenue columns (B-D) are never read -
// income-ledger owns revenue. Dry-run by default; pass --apply to write,
// matching the estate's infra-script convention.
//
// Usage:
//   bun scripts/import-workbook.ts --file <path.xlsx>              # dry-run
//   bun scripts/import-workbook.ts --file <path.xlsx> --apply      # write + reconcile
//   bun scripts/import-workbook.ts --file <path.xlsx> --apply --force
//     # delete this month's previously-imported transactions first, then re-import
//
// Requires EBK_URL (default http://127.0.0.1:4051) and EBK_TOKEN in the
// environment, and that scripts/seed.ts --apply has already run (this
// script never creates categories or accounts) - see README
// "Migration runbook".

import * as XLSX from "xlsx";

import categoriesData from "./categories.json";
import type { CategoriesConfig } from "./lib/categories-config.ts";
import { minorUnitsToMajor } from "./lib/currency.ts";
import { ymKey } from "./lib/dates.ts";
import { requireEngineEnv } from "./lib/env.ts";
import { CATEGORY_TYPE_EXPENSE, type EngineCategory, createEngineClient } from "./lib/ezbk-client.ts";
import { findTaggedTransactionIds } from "./lib/idempotency.ts";
import { findDailySheetName, resolveColumnCategory } from "./lib/mapping.ts";
import { buildPlannedTransactions, categoryKey, summarizePlan } from "./lib/plan.ts";
import { buildReconciliation, reconciliationPassed } from "./lib/reconcile.ts";
import { EXPENSE_COLUMNS } from "./lib/columns.ts";
import { parseDailySheet, parseItemizedSheet } from "./lib/workbook.ts";

interface Args {
  file: string;
  apply: boolean;
  force: boolean;
  sheet?: string;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { file: "", apply: false, force: false };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") args.file = argv[++i] ?? "";
    else if (a === "--apply") args.apply = true;
    else if (a === "--force") args.force = true;
    else if (a === "--sheet") args.sheet = argv[++i];
  }

  if (!args.file) {
    throw new Error("missing required --file <path-to-workbook.xlsx>");
  }

  return args;
}

function formatBaht(amountMinor: number): string {
  return minorUnitsToMajor(amountMinor).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const categories = categoriesData as CategoriesConfig;

  console.log(`mode: ${args.apply ? "APPLY" : "DRY-RUN (pass --apply to write)"}`);
  console.log(`file: ${args.file}`);
  console.log("");

  const workbook = XLSX.readFile(args.file, { cellDates: false });
  const sheetName = args.sheet ?? findDailySheetName(workbook.SheetNames);
  const dailySheet = workbook.Sheets[sheetName];

  if (!dailySheet) {
    throw new Error(`sheet "${sheetName}" not found in workbook (available: ${workbook.SheetNames.join(", ")})`);
  }

  console.log(`daily sheet: ${sheetName}`);

  const parsed = parseDailySheet(dailySheet, categories);

  if (parsed.rows.length === 0) {
    throw new Error("no daily rows found before the totals row - nothing to import");
  }

  const month = { year: parsed.rows[0]!.date.year, month: parsed.rows[0]!.date.month };

  for (const row of parsed.rows) {
    if (row.date.year !== month.year || row.date.month !== month.month) {
      throw new Error(
        `row ${row.rowNumber} has date ${row.date.year}-${row.date.month}, which does not match the sheet's month ${month.year}-${month.month}`,
      );
    }
  }

  console.log(`month: ${ymKey(month)} (${parsed.rows.length} daily rows)`);

  const planned = buildPlannedTransactions(parsed.rows);

  // --- itemized "ค่าใช้จ่าย" sheet: parse it, but this month it's empty and
  // there is no column-based category hint for freeform line items, so a
  // non-empty result is refused (in --apply mode) rather than guessed at.
  const itemizedRows = parseItemizedSheet(workbook.Sheets["ค่าใช้จ่าย"]);

  if (itemizedRows.length === 0) {
    console.log(`itemized "ค่าใช้จ่าย" sheet: no entries this month - skipping`);
  } else {
    console.log(`itemized "ค่าใช้จ่าย" sheet: ${itemizedRows.length} row(s) found - this script does not auto-categorize itemized entries:`);
    for (const row of itemizedRows) {
      console.log(`  row ${row.rowNumber}: ${row.date.year}-${row.date.month}-${row.date.day} ${row.description} ${row.amountMajor} (${row.note})`);
    }
    if (args.apply) {
      throw new Error(
        `refusing to import: the itemized sheet has ${itemizedRows.length} row(s) with no category mapping. Enter these manually, then re-run.`,
      );
    }
    console.log("  [dry-run] would refuse to --apply until these are handled manually.");
  }

  console.log("");

  const engine = createEngineClient(requireEngineEnv());
  const tagName = `import:${ymKey(month)}`;

  // --- idempotency gate: refuse if this month was already imported, unless --force.
  const existingTags = await engine.listTags();
  const existingTag = existingTags.find((t) => t.name === tagName);

  let taggedIds: string[] = [];
  if (existingTag) {
    const existingMonthTxns = await engine.listTransactionsByMonth(month.year, month.month);
    taggedIds = findTaggedTransactionIds(existingMonthTxns.items, existingTag.id);
  }

  if (taggedIds.length > 0) {
    if (!args.force) {
      throw new Error(
        `${taggedIds.length} transaction(s) already carry tag "${tagName}" for ${ymKey(month)}. Pass --force to delete them and re-import.`,
      );
    }

    if (args.apply) {
      console.log(`--force: deleting ${taggedIds.length} previously-imported transaction(s) tagged "${tagName}"...`);
      for (const id of taggedIds) {
        await engine.deleteTransaction(id);
      }
    } else {
      console.log(`[dry-run] --force: would delete ${taggedIds.length} previously-imported transaction(s) tagged "${tagName}"`);
    }
  }

  // --- resolve category ids (seed.ts must have already created these).
  const existingByType = await engine.listExpenseCategories();
  const existingPrimaries = existingByType[String(CATEGORY_TYPE_EXPENSE)] ?? [];

  const categoryIdByKey = new Map<string, string>();
  const labelByKey = new Map<string, string>();

  for (const primary of categories.primaries) {
    const enginePrimary: EngineCategory | undefined = existingPrimaries.find((c) => c.name === primary.label);
    if (!enginePrimary) {
      throw new Error(`category "${primary.label}" does not exist in the engine - run "bun scripts/seed.ts --apply" first`);
    }

    for (const secondaryLabel of primary.secondaries) {
      const engineSecondary = enginePrimary.subCategories?.find((c) => c.name === secondaryLabel);
      if (!engineSecondary) {
        throw new Error(`category "${primary.label} > ${secondaryLabel}" does not exist in the engine - run "bun scripts/seed.ts --apply" first`);
      }

      const key = categoryKey(primary.code, secondaryLabel);
      categoryIdByKey.set(key, engineSecondary.id);
      labelByKey.set(key, `${primary.label} > ${secondaryLabel}`);
    }
  }

  const categoryKeyByCategoryId = new Map<string, string>();
  for (const [key, id] of categoryIdByKey) categoryKeyByCategoryId.set(id, key);

  // --- resolve the cash account (workbook doesn't distinguish payment method).
  const cashAccountConfig = categories.accounts.find((a) => a.category === "cash");
  if (!cashAccountConfig) {
    throw new Error(`categories.json has no "cash" account configured`);
  }

  const existingAccounts = await engine.listAccounts();
  const cashAccount = existingAccounts.find((a) => a.name === cashAccountConfig.name);
  if (!cashAccount) {
    throw new Error(`account "${cashAccountConfig.name}" does not exist in the engine - run "bun scripts/seed.ts --apply" first`);
  }

  // --- resolve (or plan to create) the import tag.
  let tagId = existingTag?.id;
  if (!tagId) {
    if (args.apply) {
      tagId = (await engine.addTag(tagName)).id;
      console.log(`created tag: ${tagName} (id ${tagId})`);
    } else {
      console.log(`[dry-run] would create tag: ${tagName}`);
      tagId = "(new)";
    }
  }

  // --- print the plan.
  console.log("");
  console.log(`planned transactions: ${planned.length}`);
  const summary = summarizePlan(planned, labelByKey);
  for (const row of summary) {
    console.log(`  ${row.label}: ${row.count} txn(s), ${formatBaht(row.amountMinorUnits)} baht`);
  }
  console.log("");

  if (!args.apply) {
    console.log("[dry-run] no writes performed. Re-run with --apply to import and reconcile.");
    return;
  }

  // --- write.
  let created = 0;
  for (const t of planned) {
    const categoryId = categoryIdByKey.get(t.categoryKey);
    if (!categoryId) {
      throw new Error(`no category id resolved for "${t.categoryKey}" (row ${t.rowNumber}, column ${t.column})`);
    }

    await engine.addTransaction({
      categoryId,
      time: t.unixTime,
      utcOffset: t.utcOffsetMinutes,
      sourceAccountId: cashAccount.id,
      sourceAmount: t.amountMinorUnits,
      comment: t.comment,
      tagIds: [tagId],
    });
    created++;
  }

  console.log(`created ${created} of ${planned.length} planned transactions`);
  console.log("");

  // --- reconciliation gate.
  const postImportTxns = await engine.listTransactionsByMonth(month.year, month.month);
  const importedTxns = postImportTxns.items.filter((t) => t.tagIds.includes(tagId!));

  const engineTotalsMinor = new Map<string, number>();
  for (const t of importedTxns) {
    const key = categoryKeyByCategoryId.get(t.categoryId);
    if (!key) continue; // a transaction under this tag but an unresolved category - shouldn't happen, ignored for the table rather than crashing the gate
    engineTotalsMinor.set(key, (engineTotalsMinor.get(key) ?? 0) + t.sourceAmount);
  }

  const workbookTotalsMajor = new Map<string, number>();
  for (const entry of EXPENSE_COLUMNS) {
    const resolved = resolveColumnCategory(entry.column, categories);
    if (!resolved) continue;
    const key = categoryKey(resolved.code, resolved.secondaryLabel);
    const columnTotal = parsed.totals[entry.column] ?? 0;
    workbookTotalsMajor.set(key, (workbookTotalsMajor.get(key) ?? 0) + columnTotal);
  }

  const reconciliation = buildReconciliation(workbookTotalsMajor, engineTotalsMinor, labelByKey);

  console.log("Reconciliation (workbook รวม vs engine, baht):");
  console.log(`  ${"category".padEnd(40)} ${"workbook".padStart(14)} ${"engine".padStart(14)} ${"diff".padStart(10)}`);
  for (const row of reconciliation) {
    const workbookStr = row.workbookTotalMajor.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    const engineStr = formatBaht(row.engineTotalMinor);
    const diffStr = formatBaht(row.diffMinor);
    const marker = row.ok ? "" : "  <-- MISMATCH";
    console.log(`  ${row.label.padEnd(40)} ${workbookStr.padStart(14)} ${engineStr.padStart(14)} ${diffStr.padStart(10)}${marker}`);
  }

  if (!reconciliationPassed(reconciliation)) {
    console.error("\nRECONCILIATION FAILED - one or more categories do not match. Not safe to consider this month imported.");
    process.exit(1);
  }

  console.log("\nReconciliation OK - all categories match.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
