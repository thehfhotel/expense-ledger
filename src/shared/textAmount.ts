// Amount-in-text tripwire. Ported unchanged from income-ledger's
// src/shared/textAmount.ts — see that repo's copy for the full rationale
// (roughly 45 lines in the imported workbooks wrote the money INSIDE the
// Thai description instead of in the amount column, and that money landed
// in no cell anywhere). This file must never drift from the sibling's copy.
//
// looksLikeAmountInText() is a WARNING signal only — never a block, never a
// validation error, never something the server enforces.

/** Thai block, used to decide whether a match sits inside a longer word. */
const THAI = "\\u0E00-\\u0E7F";

/**
 * Tender words. Order matters: the longest alternative must come first so
 * "โอนเงิน350" matches โอนเงิน (digits adjacent) rather than โอน (followed by
 * the letters เงิน, which would fail the adjacency test).
 *
 * Bare "สด" additionally requires a non-Thai character before it. On its own
 * สด is the everyday adjective "fresh" — "ผักสด 500", "อาหารสด 300" are
 * ordinary shopping notes whose amount IS in the amount column. "เงินสด" is
 * unambiguous and is matched by its own alternative, and "(สด 300)" still
 * matches because a paren is not a Thai letter.
 */
const TENDER_WORD = `(?:เงินสด|โอนเงิน|เครดิต|โอน|(?<![${THAI}])สด)`;

/**
 * Characters allowed between the word and the number: whitespace and light
 * punctuation, never a letter or a digit. Capped at four so a word at one end
 * of a long description cannot pair with a number at the other.
 */
const GAP = "[\\s=:\\-–—()\\[\\]{}.,'\"*#/\\\\+~]{0,4}";

/** A number carrying at least two digits, thousands separators allowed. */
const NUMBER = "\\d[\\d,]*\\d";

/** Tender word, then the amount: "โอนเงิน350", "เงินสด=30", "เงินสด 1,200". */
const TENDER_THEN_NUMBER = new RegExp(`${TENDER_WORD}${GAP}${NUMBER}`, "u");

/** Amount, then the unit: "30 บาท", "1,200บาท". */
const NUMBER_THEN_BAHT = new RegExp(`${NUMBER}${GAP}บาท`, "u");

/**
 * True when `text` looks like it carries a money amount in prose — a tender
 * word next to a number of two or more digits, or a number followed by บาท.
 *
 * Advisory only. Callers show `AMOUNT_IN_TEXT_WARNING_TH` beside the field
 * and let the person save anyway.
 */
export function looksLikeAmountInText(text: string): boolean {
  if (!text) return false;
  return TENDER_THEN_NUMBER.test(text) || NUMBER_THEN_BAHT.test(text);
}

/**
 * The one wording every caller shows, so the hint reads identically
 * everywhere it is wired up.
 */
export const AMOUNT_IN_TEXT_WARNING_TH = "จำนวนเงินอยู่ในข้อความ — กรอกในช่องจำนวนหรือไม่?";
