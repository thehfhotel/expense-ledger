#!/usr/bin/env bun
// Seeds SIX hand-specified AP register ("ค้างจ่าย" tab, src/server/apStore.ts)
// rows the owner called out directly (2026-07-31 ruling), on top of the 14
// rows scripts/seed-ap-2026-07.ts already applied under created_by
// "seed:workbook-2026-07" — those 14 rows are NOT touched by this script.
//
// Why a separate script rather than extending seed-ap-2026-07.ts's own
// workbook scan: five of these six rows were excluded by that script's
// AUTOMATIC selection rule (scripts/lib/ap-seed.ts's resolveSeedCategory
// only maps Booking.com / expedia group / บุญดี — every other creditor is
// skipped for manual entry, by design, never guessed), and the sixth
// (Booking.com's เม.ย. 2569 HF-Ville row) was excluded by that same script's
// checkRowIntegrity gate because the workbook's own ยอดค้างชำระ column (L =
// 7,027.28) doesn't match amount+vat-wht-discount (7,072.28) — a real
// transcription typo in the source sheet the owner has now confirmed:
// 7,072.28 is correct, 7,027.28 was the error. These six are therefore
// hand-verified against the workbook directly (see each row's `sourceRow`
// comment below — sheet "ก.ค.-69.คุณนัท " unless noted otherwise) rather
// than run through evaluateWorkbookRow's automatic scan/integrity pipeline,
// which stays unit-tested and unchanged for the ORIGINAL 14-row batch. RULING
// 1 (2026-07, same day) made categoryCode optional on an AP row, which is
// exactly why four of these six can be entered at all: an unmapped creditor
// no longer means "must guess a category" or "must stay out of the
// register" — it can be filed with categoryCode: null (an explicit "ไม่ระบุ
// หมวด" state) and categorized later, whenever it's actually paid.
//
// Same two-run-context split as seed-ap-2026-07.ts (see that file's header
// for the full rationale): this script never needs Mode 1 (a local XLSX
// parse) at all, since the six rows below are already a fixed, hand-verified
// list — there is nothing left to scan. It only ever runs in "rows-json"
// mode, generating that JSON from the hardcoded list itself:
//
//   bun scripts/seed-ap-2026-07b.ts --out rows-b.json
//     # prints the review table and writes rows-b.json — scp that file to
//     # evergreen, `docker cp` it into the running expense-ledger container
//     # (via the operator's home directory, never /tmp — see README "AP
//     # register reconciliation" for why), then run the apply step there.
//   bun scripts/seed-ap-2026-07b.ts --rows-json rows-b.json              # dry-run
//   bun scripts/seed-ap-2026-07b.ts --rows-json rows-b.json --apply      # writes, gated by
//                                                                         # the SAME validateApRowInput the server's
//                                                                         # own POST /api/ap/rows route runs
//   bun scripts/seed-ap-2026-07b.ts --rows-json rows-b.json --apply --force
//     # first deletes any existing row whose created_by carries THIS
//     # script's SEED_MARKER, then re-applies fresh — idempotent re-run.
//   bun scripts/seed-ap-2026-07b.ts --verify
//     # queries the live store directly and prints how many rows currently
//     # carry SEED_MARKER, for post-apply proof.
//
// Mode 2 NEVER imports "xlsx" — only src/server/apStore.ts and the server's
// own exported validateApRowInput (src/server/server.ts), so a seeded row
// can never drift from what the real route would have accepted from a
// clerk typing it in by hand.
//
// Idempotency: --apply refuses if the register already holds ANY row
// carrying SEED_MARKER as created_by, unless --force is passed.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { minorUnitsToMajor } from "./lib/currency.ts";
import { toApRowInput, type SeedRow } from "./lib/ap-seed.ts";
import { computeGross, computeOutstanding } from "../src/shared/apTypes.ts";

/** Distinguishes rows THIS script created from both a clerk entry and from
 * seed-ap-2026-07.ts's own "seed:workbook-2026-07" batch — that batch (14
 * rows) is explicitly out of scope here and must never be touched. */
export const SEED_MARKER = "seed:workbook-2026-07b";

/**
 * The six owner-specified rows (2026-07-31 ruling). Every `sourceRow` /
 * sheet reference below was read directly from
 * "ค่าใช้จ่ายคุณวิณัฐ สายชล.xlsx" and cross-checked against the ruling text;
 * amounts are already in satang (baht * 100, no further rounding needed —
 * every figure here has at most 2 decimal places).
 */
const HAND_SPECIFIED_ROWS: SeedRow[] = [
  {
    // Same bill also appears (identically) in the "พ.ค.-69.คุณนัท " and
    // "มิ.ย.-69.คุณนัท " sheets — a carried-forward unpaid commission bill.
    // Sheet "ก.ค.-69.คุณนัท ", row 25. Workbook column L (ยอดค้างชำระ) reads
    // 7,027.28 — a transcription typo the owner has now confirmed: the
    // correct amount is 7,072.28 (this row's own จำนวนเงิน column, C).
    // amount alone (no VAT/WHT/discount) is what the ruling instructs, so
    // the app computes outstanding = 7,072.28 directly, matching the
    // owner-confirmed figure exactly.
    sourceRow: 25,
    creditor: "Booking.com",
    item: "ค่าคอมมิชชั่น booking.com เดือน เม.ย. 2569(HF-Ville)",
    amountSatang: 707_228,
    vatSatang: null,
    whtSatang: null,
    discountSatang: 0,
    dueDate: "2026-04-30",
    entity: "HF Ville",
    categoryCode: "commission-booking",
    note: "ยอดในชีทช่อง L ระบุ 7,027.28 ซึ่งคลาดเคลื่อน เจ้าของกิจการยืนยันยอดที่ถูกต้องคือ 7,072.28 บาท",
    flags: ["owner-confirmed-amount-override"],
  },
  {
    // Sheet "ก.ค.-69.คุณนัท ", row 40. No creditor/item category mapping
    // exists for ร้าน47ไวนิล (RULING 1: filed with categoryCode: null —
    // "ไม่ระบุหมวด" — rather than guessed or skipped).
    sourceRow: 40,
    creditor: "ร้าน47ไวนิล",
    item: "สติกเกอร์ติดพลาสวูด3 มิล ขนาด 10*20ซม.",
    amountSatang: 338_000,
    vatSatang: null,
    whtSatang: null,
    discountSatang: 0,
    dueDate: "2026-05-04",
    entity: "บจก.สายชล เฮอริเทจ",
    categoryCode: null,
    note: "",
    flags: ["hand-specified", "no-category-mapping"],
  },
  {
    // Sheet "ก.ค.-69.คุณนัท ", row 42.
    sourceRow: 42,
    creditor: "บริษัท พีวี ที ไทยเจริญ จำกัด",
    item: "ค่าสอบบัญชี -ประจำปี68",
    amountSatang: 2_000_000,
    vatSatang: null,
    whtSatang: null,
    discountSatang: 0,
    dueDate: "2026-05-25",
    entity: "บจก.สายชล เฮอริเทจ",
    categoryCode: null,
    note: "พี่แป๋วเอามาให้ 11-6-69",
    flags: ["hand-specified", "no-category-mapping"],
  },
  {
    // Sheet "ก.ค.-69.คุณนัท ", row 44 — ค่าภาษีป้าย. Same "จ่ายไม่เกิน
    // 31/7/69" payment-deadline warning as rows 45/46 below (all three are
    // the same municipality's due-31-July bills).
    sourceRow: 44,
    creditor: "เทศบาลนครสุราษฎร์ธานี",
    item: "ค่าภาษีป้าย  บจก. สายชลเฮอริเทจ",
    amountSatang: 1_341_600,
    vatSatang: null,
    whtSatang: null,
    discountSatang: 0,
    dueDate: "2026-07-31",
    entity: "บจก.สายชล เฮอริเทจ",
    categoryCode: null,
    note: "จ่ายไม่เกิน 31/7/69   ห้ามเกินจะมีค่าปรับเกิดขึ้น",
    flags: ["hand-specified", "no-category-mapping"],
  },
  {
    // Sheet "ก.ค.-69.คุณนัท ", row 45 — ค่าภาษีที่ดิน (HF, บ้านเลขที่ 33).
    sourceRow: 45,
    creditor: "เทศบาลนครสุราษฎร์ธานี",
    item: "ค่าภาษีที่ดินHf ( บ้านเลขที่ 33 )",
    amountSatang: 3_424_696,
    vatSatang: null,
    whtSatang: null,
    discountSatang: 0,
    dueDate: "2026-07-31",
    entity: "HF",
    categoryCode: null,
    note: "จ่ายไม่เกิน 31/7/69   ห้ามเกินจะมีค่าปรับเกิดขึ้น",
    flags: ["hand-specified", "no-category-mapping"],
  },
  {
    // Sheet "ก.ค.-69.คุณนัท ", row 46 — ค่าภาษีที่ดิน (HF-VILLE, บ้านเลขที่
    // 196/6). The sheet's ในนาม (entity) cell is blank for this one row.
    sourceRow: 46,
    creditor: "เทศบาลนครสุราษฎร์ธานี",
    item: "ค่าภาษีที่ดินHf-VILLE ( บ้านเลขที่ 196/6)",
    amountSatang: 441_142,
    vatSatang: null,
    whtSatang: null,
    discountSatang: 0,
    dueDate: "2026-07-31",
    entity: "",
    categoryCode: null,
    note: "จ่ายไม่เกิน 31/7/69   ห้ามเกินจะมีค่าปรับเกิดขึ้น",
    flags: ["hand-specified", "no-category-mapping"],
  },
];

interface Args {
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
    if (a === "--out") args.out = argv[++i];
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
  console.log(`Rows (${rows.length}):`);
  console.log("");
  const header = ["#", "creditor", "item", "amount (บาท)", "due", "entity", "category", "note"];
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
          r.entity || "(blank)",
          r.categoryCode ?? "(ไม่ระบุหมวด)",
          r.note || "(none)",
        ].join(" | "),
    );
  }
  console.log("");
  const total = rows.reduce((sum, r) => sum + r.amountSatang, 0);
  console.log(`Total: ${rows.length} row(s), ${formatBaht(total)} baht.`);
}

interface RowsJsonFile {
  marker: string;
  generatedAt: string;
  rows: SeedRow[];
}

function buildRowsJsonFile(): RowsJsonFile {
  return { marker: SEED_MARKER, generatedAt: new Date().toISOString(), rows: HAND_SPECIFIED_ROWS };
}

async function runGenerate(args: Args): Promise<void> {
  console.log("mode: GENERATE (hand-specified rows, no workbook parse needed)");
  console.log("");
  printSeedTable(HAND_SPECIFIED_ROWS);

  if (args.out) {
    writeFileSync(args.out, JSON.stringify(buildRowsJsonFile(), null, 2));
    console.log("");
    console.log(`wrote ${HAND_SPECIFIED_ROWS.length} row(s) to ${args.out} — scp this to evergreen, docker cp it into`);
    console.log(`the expense-ledger container (via the operator's home directory, never /tmp), then run Mode 2 there`);
    console.log(`(--rows-json ${args.out}).`);
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
  console.log(`rows-json: ${args.rowsJson} (generated ${payload.generatedAt})`);
  console.log("");
  printSeedTable(payload.rows);

  if (!args.apply) {
    console.log("");
    console.log("[dry-run] no writes performed. Re-run with --apply to write.");
    return;
  }

  // Everything below touches apStore/server.ts — imported dynamically so
  // this stays consistent with seed-ap-2026-07.ts's own convention (never a
  // hard dependency for the pure generate/print path above).
  const apStore = await import("../src/server/apStore.ts");
  const { validateApRowInput } = await import("../src/server/server.ts");

  console.log("");

  // ── idempotency gate — scoped to THIS script's marker only; the original
  // 14-row "seed:workbook-2026-07" batch is a completely separate set and is
  // never touched here. ───────────────────────────────────────────────────
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
  // BEFORE writing anything (all-or-nothing) — RULING 1 means a null
  // categoryCode now passes this gate too. ──────────────────────────────────
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
    console.log(`  ${r.id}: ${r.creditor} — ${r.item} (${formatBaht(r.outstandingSatang)} baht outstanding, category ${r.categoryCode ?? "ไม่ระบุหมวด"})`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.verify) {
    await runVerify();
    return;
  }
  if (args.rowsJson) {
    await runRowsJsonMode(args);
    return;
  }
  await runGenerate(args);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
