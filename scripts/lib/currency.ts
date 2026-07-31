// ezBookkeeping stores ALL amounts as an integer scaled by a fixed factor of
// 100 regardless of the account currency's own decimal "fraction" (verified
// against v1.6.1's src/consts/numeral.ts: AMOUNT_FACTOR = 10 **
// MAX_SUPPORTED_DECIMAL_NUMBER_COUNT, MAX_SUPPORTED_DECIMAL_NUMBER_COUNT = 2
// - and src/lib/numeral.ts's amount parser multiplies user-entered amounts
// by that same AMOUNT_FACTOR before they ever reach the API). For THB
// (fraction: 2 in src/consts/currency.ts) that integer unit is satang:
// 100.00 THB is sent/stored as sourceAmount = 10000.

export const CURRENCY_MINOR_UNIT_FACTOR = 100;

/** Baht (major unit, e.g. 100.50) -> satang (minor unit integer, e.g. 10050). */
export function amountToMinorUnits(amountMajor: number): number {
  return Math.round(amountMajor * CURRENCY_MINOR_UNIT_FACTOR);
}

/** Satang -> baht, for display only. */
export function minorUnitsToMajor(amountMinor: number): number {
  return amountMinor / CURRENCY_MINOR_UNIT_FACTOR;
}
