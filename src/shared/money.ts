// Money = integer satang end to end (1 baht = 100 satang). Nothing but this
// module ever converts to/from baht, and only at the UI edge. Ported
// unchanged from income-ledger's src/shared/money.ts — see that repo's copy
// for the canonical version; this file must never drift from it.

/** 298380 -> "2,983.80" */
export function formatSatang(satang: number): string {
  const baht = satang / 100;
  return baht.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Parse a user-typed baht amount ("2,983.80", "20", " 490.5 ") into satang.
 * Returns null for anything that isn't a valid non-negative amount with at
 * most 2 decimal places — including empty input.
 */
export function parseAmountToSatang(input: string): number | null {
  const trimmed = input.trim().replace(/,/g, "");
  if (trimmed === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
  const baht = Number(trimmed);
  if (!Number.isFinite(baht)) return null;
  return Math.round(baht * 100);
}
