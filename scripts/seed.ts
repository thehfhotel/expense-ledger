#!/usr/bin/env bun
// Idempotent seed: creates the canonical expense categories (from
// categories.json) and the two accounts (เงินสด, ธนาคาร) that don't already
// exist by name. Never modifies or deletes anything. Re-running is a no-op
// once everything exists. Dry-run by default; pass --apply to write,
// matching the estate's infra-script convention (see HF-erp's
// infra/cloudflare/*.ts).
//
// Usage:
//   bun scripts/seed.ts              # dry-run, prints the plan
//   bun scripts/seed.ts --apply      # creates whatever's missing
//
// Requires EBK_URL (default http://127.0.0.1:4051) and EBK_TOKEN in the
// environment - see README "Migration runbook".

import categoriesData from "./categories.json";
import type { CategoriesConfig } from "./lib/categories-config.ts";
import { requireEngineEnv } from "./lib/env.ts";
import { ACCOUNT_CATEGORY_CASH, ACCOUNT_CATEGORY_CHECKING, CATEGORY_TYPE_EXPENSE, type EngineCategory, createEngineClient } from "./lib/ezbk-client.ts";

function parseArgs(argv: string[]): { apply: boolean } {
  return { apply: argv.includes("--apply") };
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const config = categoriesData as CategoriesConfig;
  const client = createEngineClient(requireEngineEnv());

  console.log(`mode: ${apply ? "APPLY" : "DRY-RUN (pass --apply to write)"}`);
  console.log("");

  const existingByType = await client.listExpenseCategories();
  const existingPrimaries = existingByType[String(CATEGORY_TYPE_EXPENSE)] ?? [];

  let createdPrimaries = 0;
  let skippedPrimaries = 0;
  let createdSecondaries = 0;
  let skippedSecondaries = 0;

  for (const primary of config.primaries) {
    let existingPrimary: EngineCategory | undefined = existingPrimaries.find((c) => c.name === primary.label);

    if (existingPrimary) {
      console.log(`skip primary category: ${primary.label} (id ${existingPrimary.id})`);
      skippedPrimaries++;
    } else {
      console.log(`${apply ? "create" : "[dry-run] would create"} primary category: ${primary.label}`);
      createdPrimaries++;

      if (apply) {
        existingPrimary = await client.addCategory({ name: primary.label, parentId: "0", icon: primary.icon, color: primary.color });
      }
    }

    const existingSecondaries = existingPrimary?.subCategories ?? [];

    for (const secondaryLabel of primary.secondaries) {
      const existingSecondary = existingSecondaries.find((c) => c.name === secondaryLabel);

      if (existingSecondary) {
        console.log(`  skip secondary category: ${primary.label} > ${secondaryLabel} (id ${existingSecondary.id})`);
        skippedSecondaries++;
        continue;
      }

      console.log(`  ${apply ? "create" : "[dry-run] would create"} secondary category: ${primary.label} > ${secondaryLabel}`);
      createdSecondaries++;

      if (apply) {
        if (!existingPrimary) {
          throw new Error(`cannot create secondary "${secondaryLabel}" - primary "${primary.label}" was not created`);
        }
        await client.addCategory({ name: secondaryLabel, parentId: existingPrimary.id, icon: primary.icon, color: primary.color });
      }
    }
  }

  console.log("");

  const existingAccounts = await client.listAccounts();
  let createdAccounts = 0;
  let skippedAccounts = 0;

  for (const account of config.accounts) {
    const existing = existingAccounts.find((a) => a.name === account.name);

    if (existing) {
      console.log(`skip account: ${account.name} (id ${existing.id})`);
      skippedAccounts++;
      continue;
    }

    console.log(`${apply ? "create" : "[dry-run] would create"} account: ${account.name}`);
    createdAccounts++;

    if (apply) {
      const category = account.category === "cash" ? ACCOUNT_CATEGORY_CASH : ACCOUNT_CATEGORY_CHECKING;
      await client.addAccount({ name: account.name, category, icon: account.icon, color: account.color });
    }
  }

  console.log("");
  console.log(`primary categories:   ${createdPrimaries} ${apply ? "created" : "to create"}, ${skippedPrimaries} already existed`);
  console.log(`secondary categories: ${createdSecondaries} ${apply ? "created" : "to create"}, ${skippedSecondaries} already existed`);
  console.log(`accounts:             ${createdAccounts} ${apply ? "created" : "to create"}, ${skippedAccounts} already existed`);

  const pending = createdPrimaries + createdSecondaries + createdAccounts;

  if (!apply && pending > 0) {
    console.log("\nRe-run with --apply to create the above.");
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
