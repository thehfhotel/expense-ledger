#!/usr/bin/env bun
// AP register reconciliation (report-only, H4/M3 fix). Diffs the AP
// register's own payment rows (src/server/apStore.ts's ap_payment table)
// against ezBookkeeping's `ap:<rowId>`-tagged transactions, and reports two
// directions of mismatch:
//
//   - DANGLING local payments: an ap_payment row whose linked transaction id
//     no longer exists in the engine at all (H2b's own scenario — a payment
//     undo whose compensating step failed after the engine delete already
//     succeeded, or a manual delete via ezBookkeeping's own UI).
//   - ORPHAN engine transactions: an engine transaction carrying an
//     `ap:<rowId>` tag that no local ap_payment row references (H4's
//     compensating-delete-failed scenario — the ledger transaction posted
//     but the local insert didn't, and even the compensating delete failed).
//
// Never writes anything. Exits 1 on ANY mismatch (report-only — nothing here
// fixes a mismatch automatically); exits 0 and prints "OK" otherwise.
//
// ── Two data sources, two different reach mechanisms ───────────────────────
//
// The ENGINE: EBK_URL (default http://127.0.0.1:4051) / EBK_TOKEN, the exact
// same convention as scripts/seed.ts and scripts/import-workbook.ts — see
// README "Migration runbook".
//
// The AP register's OWN sqlite (src/server/apStore.ts's ap.db): this repo's
// ONE database of its own (CLAUDE.md's "AP register storage exception"),
// on the FRONTEND container's `expense_ap` volume — there is no HTTP surface
// for it at all, unlike the engine. The simplest mechanism that actually
// works, chosen over extracting a volume snapshot: run this script INSIDE
// the running `expense-ledger` container via `docker exec`, where
// AP_DB_PATH's default below (/app/data/ap.db) is already the real,
// correctly-mounted file, and the engine is reachable at its compose-network
// hostname. See README "AP register reconciliation" for the exact
// invocation this repo documents and this GATE step actually runs:
//
//   docker exec expense-ledger sh -c \
//     'EBK_URL=http://expense-ledger-engine:8080 EBK_TOKEN=$ENGINE_API_TOKEN \
//      bun scripts/reconcile-ap.ts'
//
// (scripts/ ships inside the runtime image — see Dockerfile's `COPY scripts
// ./scripts` in BOTH stages — so this file is already present in the
// container; no extra deploy step needed.) EBK_TOKEN reuses the container's
// own ENGINE_API_TOKEN — the same credential, read via a different env var
// name purely because that's this script family's existing convention.
//
// A register that has never been used at all (no ap.db file yet) is
// trivially clean — reported as such, with zero engine calls, so this never
// requires EBK_TOKEN to be set just to prove there is nothing to reconcile.

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { requireEngineEnv } from "./lib/env.ts";
import { createEngineClient, EngineRequestError } from "./lib/ezbk-client.ts";

// Matches src/server/apStore.ts's own DEFAULT_DB_PATH — see this file's
// header comment for why an in-container run needs no override at all.
const DEFAULT_AP_DB_PATH = "/app/data/ap.db";

function apDbPath(): string {
  return process.env.AP_DB_PATH || DEFAULT_AP_DB_PATH;
}

interface ApRowRaw {
  id: string;
  filed_date: string;
}

interface ApPaymentRaw {
  id: string;
  row_id: string;
  transaction_id: string;
  date: string;
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Every "YYYY-MM" month from startMonth through endMonth, inclusive. */
function monthsFrom(startMonth: string, endMonth: string): string[] {
  const months: string[] = [];
  let [y, m] = startMonth.split("-").map(Number) as [number, number];
  const [endY, endM] = endMonth.split("-").map(Number) as [number, number];
  while (y < endY || (y === endY && m <= endM)) {
    months.push(monthKey(y, m));
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return months;
}

async function main() {
  const path = apDbPath();
  if (!existsSync(path)) {
    console.log(`AP register: no database at ${path} yet (never used) — nothing to reconcile.`);
    console.log("\nOK — the AP register and the engine agree.");
    return;
  }

  const db = new Database(path, { readonly: true });
  const rows = db.query("SELECT id, filed_date FROM ap_row").all() as ApRowRaw[];
  const payments = db.query("SELECT id, row_id, transaction_id, date FROM ap_payment").all() as ApPaymentRaw[];
  db.close();

  console.log(`AP register: ${rows.length} row(s), ${payments.length} payment(s) at ${path}.`);

  if (rows.length === 0 && payments.length === 0) {
    console.log("\nOK — the AP register and the engine agree (register is empty).");
    return;
  }

  const client = createEngineClient(requireEngineEnv());

  // ── Direction 1: dangling local payments (H2b) ────────────────────────────
  const dangling: ApPaymentRaw[] = [];
  for (const p of payments) {
    try {
      await client.getTransaction(p.transaction_id);
    } catch (err) {
      if (err instanceof EngineRequestError) dangling.push(p);
      else throw err;
    }
  }

  // ── Direction 2: orphan engine transactions (H4) ──────────────────────────
  // Walked month-by-month via listTransactionsByMonth (no page cap, unlike
  // the general list endpoint) over exactly the range the local data could
  // possibly span — a brand-new/empty register has an empty range, by
  // design (see the empty-register short-circuit above).
  const knownTxnIds = new Set(payments.map((p) => p.transaction_id));
  const tags = await client.listTags();
  const apTagIdToRowId = new Map<string, string>();
  for (const t of tags) {
    if (t.name.startsWith("ap:")) apTagIdToRowId.set(t.id, t.name.slice(3));
  }

  const orphans: { transactionId: string; rowId: string }[] = [];
  if (apTagIdToRowId.size > 0) {
    const dates = [...rows.map((r) => r.filed_date), ...payments.map((p) => p.date)].filter(Boolean).sort();
    const startMonth = dates[0]!.slice(0, 7);
    const now = new Date();
    const endMonth = monthKey(now.getUTCFullYear(), now.getUTCMonth() + 1);
    for (const month of monthsFrom(startMonth, endMonth)) {
      const [year, mo] = month.split("-").map(Number) as [number, number];
      const { items } = await client.listTransactionsByMonth(year, mo);
      for (const item of items) {
        for (const tagId of item.tagIds ?? []) {
          const rowId = apTagIdToRowId.get(String(tagId));
          if (!rowId) continue;
          if (!knownTxnIds.has(item.id)) orphans.push({ transactionId: item.id, rowId });
        }
      }
    }
  }

  console.log("");
  if (dangling.length === 0) {
    console.log("Dangling local payments (linked transaction missing in the engine): none.");
  } else {
    console.log(`Dangling local payments (linked transaction missing in the engine): ${dangling.length}`);
    for (const p of dangling) {
      console.log(`  payment ${p.id} (row ${p.row_id}) -> missing transaction ${p.transaction_id}`);
    }
  }

  console.log("");
  if (orphans.length === 0) {
    console.log("Orphan engine transactions (ap:-tagged, no matching local payment): none.");
  } else {
    console.log(`Orphan engine transactions (ap:-tagged, no matching local payment): ${orphans.length}`);
    for (const o of orphans) {
      console.log(`  transaction ${o.transactionId} tagged ap:${o.rowId} has no matching local payment row`);
    }
  }

  if (dangling.length > 0 || orphans.length > 0) {
    console.log("\nMISMATCH — investigate before trusting the register.");
    process.exit(1);
  }
  console.log("\nOK — the AP register and the engine agree.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
