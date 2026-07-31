#!/usr/bin/env bun
// Seeds the production AP register ("ค้างจ่าย" tab, src/server/apStore.ts)
// with the OPEN, unpaid rows from July 2026's office workbook (creditor:
// คุณวิณัฐ สายชล / "คุณนัท"), sheet "ก.ค.-69.คุณนัท " (note the trailing
// space — the workbook's own sheet naming, not a typo introduced here).
// Selection/mapping RULES live in code (scripts/lib/ap-seed.ts), never
// hardcoded per row — see that file's header comment for the exact rule
// text and column layout.
//
// ── Two run contexts, joined only by a JSON file ────────────────────────
//
// The workbook lives on the operator's laptop; the AP register's own
// sqlite (src/server/apStore.ts's ap.db) lives on evergreen, inside the
// expense-ledger container's `expense_ap` volume. That container's runtime
// image never installs "xlsx" (a devDependency only — see Dockerfile's
// `bun install --production` in the runtime stage), and the source
// spreadsheet must never be copied onto the server at all. So:
//
// MODE 1 — LOCAL DRY RUN (run on your laptop, where `xlsx` is installed
// and the workbook file lives):
//   bun scripts/seed-ap-2026-07.ts --file <path.xlsx> [--sheet "<name>"] [--out <rows.json>]
//
//   Parses the workbook, applies every rule in scripts/lib/ap-seed.ts, and
//   prints the full review table (seeded rows + skipped rows + reasons).
//   NEVER writes to any store. With --out, ALSO writes the resulting seed
//   row set as JSON — scp that file to evergreen, `docker cp` it into the
//   running expense-ledger container, then run Mode 2 there. This file
//   contains real financial figures — never commit it, and delete it (on
//   the laptop, on evergreen's host, and inside the container) once the
//   apply below is done and reconciled.
//
// MODE 2 — ROWS-JSON DRY RUN OR APPLY (run INSIDE the expense-ledger
// container via `docker exec` — the exact container-access pattern
// scripts/reconcile-ap.ts already documents in README "AP register
// reconciliation"):
//   bun scripts/seed-ap-2026-07.ts --rows-json <rows.json>              # dry-run (prints the table again, no writes)
//   bun scripts/seed-ap-2026-07.ts --rows-json <rows.json> --apply      # writes via apStore.createApRow, gated by
//                                                                        # the SAME validateApRowInput the server's
//                                                                        # own POST /api/ap/rows route runs
//   bun scripts/seed-ap-2026-07.ts --rows-json <rows.json> --apply --force
//     # first deletes any existing row whose created_by carries THIS
//     # script's SEED_MARKER (see below), then re-applies fresh — idempotent
//     # re-run. A seed row that a clerk has since started paying down is
//     # left in place with a warning rather than crashing the run
//     # (apStore.deleteApRow refuses to delete a row with payment history,
//     # by design — see src/server/apStore.ts).
//   bun scripts/seed-ap-2026-07.ts --verify
//     # no file/JSON needed — queries the live store directly and prints
//     # how many rows currently carry SEED_MARKER, for post-apply proof.
//
// Mode 2 NEVER imports "xlsx" — only src/server/apStore.ts and the
// server's own exported validateApRowInput (src/server/server.ts), so a
// seeded row can never drift from what the real route would have accepted
// from a clerk typing it in by hand. created_by = SEED_MARKER is the ONLY
// field that distinguishes a seeded row from a clerk entry — schema-wise
// it is a completely ordinary AP row: editable, deletable (while it carries
// zero payments), payable through the normal ค้างจ่าย UI.
//
// Idempotency: --apply refuses if the register already holds ANY row
// carrying SEED_MARKER as created_by, unless --force is passed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { minorUnitsToMajor } from "./lib/currency.ts";
import { evaluateWorkbookRow, toApRowInput, type SeedRow, type SkippedRow } from "./lib/ap-seed.ts";
import { computeGross, computeOutstanding } from "../src/shared/apTypes.ts";

/** The ONE marker distinguishing a row this script created from a clerk
 * entry (src/server/apStore.ts's created_by column, a plain TEXT field with
 * no format requirement — see apStore.createApRow). Bump the date suffix if
 * this script is ever copied for a different month's workbook, so two
 * seed runs never collide on the same marker. */
export const SEED_MARKER = "seed:workbook-2026-07";

const DEFAULT_SHEET_NAME = "ก.ค.-69.คุณนัท ";

interface Args {
  file?: string;
  sheet?: string;
  out?: string;
  rowsJson?: string;
  apply: boolean;
  force: boolean;
  verify: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, force: false, verify: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--file") args.file = argv[++i];
    else if (a === "--sheet") args.sheet = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--rows-json") args.rowsJson = argv[++i];
    else if (a === "--apply") args.apply = true;
    else if (a === "--force") args.force = true;
    else if (a === "--verify") args.verify = true;
    else throw new Error(`unrecognized argument: ${a}`);
  }
  return args;
}

function formatBaht(satang: number): string {
  return minorUnitsToMajor(satang).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function printSeedTable(rows: SeedRow[]): void {
  console.log(`Seeded rows (${rows.length}):`);
  console.log("");
  const header = ["#", "creditor", "item", "amount (บาท)", "due", "entity", "category", "flag", "note"];
  console.log("  " + header.join(" | "));
  for (const r of rows) {
    console.log(
      "  " +
        [
          String(r.sourceRow),
          r.creditor,
          r.item,
          formatBaht(r.amountSatang),
          r.dueDate ?? "(blank)",
          r.entity,
          r.categoryCode,
          r.flags.join("+"),
          r.note || "(none)",
        ].join(" | "),
    );
  }
  console.log("");
  const total = rows.reduce((sum, r) => sum + r.amountSatang, 0);
  console.log(`Total: ${rows.length} row(s), ${formatBaht(total)} baht.`);
}

function printSkipTable(rows: SkippedRow[]): void {
  if (rows.length === 0) {
    console.log("Skipped rows: none.");
    return;
  }
  console.log(`Skipped rows (${rows.length}) — NOT seeded, needs manual entry:`);
  console.log("");
  for (const r of rows) {
    console.log(`  row ${r.sourceRow}: ${r.creditor} — ${r.item} (ยอดค้างชำระ ${r.outstandingBaht.toFixed(2)} baht)`);
    console.log(`    reason: ${r.reason}`);
  }
}

interface RowsJsonFile {
  marker: string;
  generatedAt: string;
  sourceFile: string;
  sourceSheet: string;
  rows: SeedRow[];
  skipped: SkippedRow[];
}

async function runLocalDryRun(args: Args): Promise<void> {
  if (!args.file) throw new Error("missing --file <path.xlsx>");
  if (!existsSync(args.file)) throw new Error(`file not found: ${args.file}`);

  // Dynamic import: "xlsx" is a devDependency, absent from the runtime
  // container image — this branch only ever runs on the operator's laptop,
  // and a top-level static import would break Mode 2 inside the container
  // even though that path never touches XLSX at all.
  const XLSX = await import("xlsx");

  const sheetName = args.sheet ?? DEFAULT_SHEET_NAME;
  const workbook = XLSX.readFile(args.file, { cellDates: false });
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`sheet "${sheetName}" not found (available: ${workbook.SheetNames.join(", ")})`);
  }

  const allRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: "" });

  const seeded: SeedRow[] = [];
  const skipped: SkippedRow[] = [];
  // Data starts at row 4 (1-indexed) — header row 2, subheader row 3.
  for (let i = 3; i < allRows.length; i++) {
    const rowNumber = i + 1;
    const row = allRows[i]!;
    if (String(row[0] ?? "").trim() === "รวม") break; // totals row — stop
    const evaluation = evaluateWorkbookRow(row, rowNumber);
    if (evaluation.kind === "seed") seeded.push(evaluation.row);
    else if (evaluation.kind === "skip") skipped.push(evaluation.row);
  }

  console.log(`mode: LOCAL DRY RUN`);
  console.log(`file: ${args.file}`);
  console.log(`sheet: ${sheetName}`);
  console.log("");
  printSeedTable(seeded);
  console.log("");
  printSkipTable(skipped);

  if (args.out) {
    const payload: RowsJsonFile = {
      marker: SEED_MARKER,
      generatedAt: new Date().toISOString(),
      sourceFile: args.file,
      sourceSheet: sheetName,
      rows: seeded,
      skipped,
    };
    writeFileSync(args.out, JSON.stringify(payload, null, 2));
    console.log("");
    console.log(`wrote ${seeded.length} row(s) to ${args.out} — scp this to evergreen, docker cp it into the`);
    console.log(`expense-ledger container, then run Mode 2 there (--rows-json ${args.out}).`);
    console.log("NEVER commit this file — it carries real financial figures.");
  }
}

async function runRowsJsonMode(args: Args): Promise<void> {
  if (!args.rowsJson) throw new Error("missing --rows-json <rows.json>");
  if (!existsSync(args.rowsJson)) throw new Error(`file not found: ${args.rowsJson}`);

  const payload = JSON.parse(readFileSync(args.rowsJson, "utf8")) as RowsJsonFile;
  if (payload.marker !== SEED_MARKER) {
    throw new Error(
      `rows-json marker "${payload.marker}" does not match this script's SEED_MARKER "${SEED_MARKER}" — wrong file or wrong script version`,
    );
  }

  console.log(`mode: ${args.apply ? "APPLY" : "DRY-RUN (pass --apply to write)"}`);
  console.log(`rows-json: ${args.rowsJson} (generated ${payload.generatedAt} from ${payload.sourceFile} / sheet "${payload.sourceSheet}")`);
  console.log("");
  printSeedTable(payload.rows);
  console.log("");
  printSkipTable(payload.skipped);

  if (!args.apply) {
    console.log("");
    console.log("[dry-run] no writes performed. Re-run with --apply to write.");
    return;
  }

  // Everything below touches apStore/server.ts — imported dynamically so
  // Mode 1 (the laptop dry run, which never needs the store) can't be
  // affected by anything specific to the store's lazy-open/prod checks.
  const apStore = await import("../src/server/apStore.ts");
  const { validateApRowInput } = await import("../src/server/server.ts");

  console.log("");

  // ── idempotency gate ───────────────────────────────────────────────────
  const existing = apStore.listApRows({ mode: "all" });
  const seededExisting = existing.filter((r) => r.createdBy === SEED_MARKER);

  if (seededExisting.length > 0) {
    if (!args.force) {
      throw new Error(
        `${seededExisting.length} row(s) already carry created_by "${SEED_MARKER}" — refusing to re-apply. Pass --force to delete them and re-seed.`,
      );
    }
    console.log(`--force: deleting ${seededExisting.length} previously-seeded row(s)...`);
    let deleted = 0;
    for (const row of seededExisting) {
      try {
        apStore.deleteApRow(row.id);
        deleted++;
      } catch (err) {
        if (err instanceof apStore.ApRowHasPaymentsError) {
          console.warn(
            `  WARNING: row ${row.id} (${row.creditor} — ${row.item}) has payment history and was NOT deleted — investigate manually. Skipping.`,
          );
          continue;
        }
        throw err;
      }
    }
    console.log(`deleted ${deleted} of ${seededExisting.length} previously-seeded row(s).`);
    console.log("");
  }

  // ── validate every row through the SAME gate the server's own route uses,
  // BEFORE writing anything (all-or-nothing) ───────────────────────────────
  const toWrite: ReturnType<typeof toApRowInput>[] = [];
  for (const row of payload.rows) {
    const candidate = toApRowInput(row);
    const validated = validateApRowInput(candidate);
    if (!validated.ok) {
      throw new Error(`row ${row.sourceRow} (${row.creditor} — ${row.item}) failed server validation: ${validated.error}`);
    }
    const gross = computeGross(validated.value.amountSatang, validated.value.vatSatang, validated.value.whtSatang);
    if (computeOutstanding(gross, [], validated.value.discountSatang) < 0) {
      throw new Error(`row ${row.sourceRow} (${row.creditor} — ${row.item}) would have negative outstanding — refusing to write any row`);
    }
    toWrite.push(validated.value);
  }

  console.log(`writing ${toWrite.length} row(s) with created_by = "${SEED_MARKER}"...`);
  let created = 0;
  for (const input of toWrite) {
    const id = apStore.createApRow(input, SEED_MARKER);
    console.log(`  created ${id}: ${input.creditor} — ${input.item} (${formatBaht(input.amountSatang)} baht)`);
    created++;
  }

  console.log("");
  console.log(`created ${created} of ${toWrite.length} planned row(s).`);
}

async function runVerify(): Promise<void> {
  const apStore = await import("../src/server/apStore.ts");
  const all = apStore.listApRows({ mode: "all" });
  const seeded = all.filter((r) => r.createdBy === SEED_MARKER);
  const totalOutstanding = seeded.reduce((sum, r) => sum + r.outstandingSatang, 0);

  console.log(`AP register: ${all.length} row(s) total.`);
  console.log(`Rows carrying created_by = "${SEED_MARKER}": ${seeded.length}`);
  console.log(`Total outstanding on seeded rows: ${formatBaht(totalOutstanding)} baht.`);
  for (const r of seeded) {
    console.log(`  ${r.id}: ${r.creditor} — ${r.item} (${formatBaht(r.outstandingSatang)} baht outstanding)`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.verify) {
    await runVerify();
    return;
  }
  if (args.file) {
    await runLocalDryRun(args);
    return;
  }
  if (args.rowsJson) {
    await runRowsJsonMode(args);
    return;
  }
  throw new Error("pass --file <path.xlsx> (local dry-run), --rows-json <rows.json> (apply path), or --verify");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
