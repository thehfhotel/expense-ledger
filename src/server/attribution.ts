// Attribution format — LOCKED CONTRACT shared with hf-mcp (frontend spec
// §5). Changing this is a contract change, not a routine edit.
//
//   comment = <clerkText> "\n" "[hf:by=" <email> "]"
//
// Rules (verbatim from the spec):
//   1. The token is always the final line, exactly once, appended
//      server-side only. The client never sends it and never renders it.
//   2. When clerkText is empty the comment is the token alone, with no
//      leading newline.
//   3. The separator is a single LF; clerkText is trailing-trimmed first.
//   4. Before appending, every line in clerkText that fully matches
//      /^[ \t]*\[hf:[^\]\n]*\][ \t]*$/m is removed, at any position — a
//      clerk cannot forge, duplicate or displace attribution.
//   5. <email> is the lowercased `email` claim of the verified Access JWT.
//      Never a client-supplied value.
//   6. `by` means the identity that last wrote this transaction (create or
//      edit) — on edit the server strips and re-appends with the current
//      editor.
//   7. Extension slot, reserved now: the payload may later carry `;k=v`
//      pairs, e.g. `[hf:by=a@b.co;cr=c@d.co]`. Readers MUST ignore unknown
//      keys rather than fail.

/** Matches a full line that is entirely an [hf:...] token — used to strip
 * any clerk-typed look-alike before appending the real one (rule 4). The
 * `m` flag makes `^`/`$` match at line boundaries; `[ \t]*` allows
 * surrounding horizontal whitespace but not a blank line either side. */
const FORGED_TOKEN_LINE_RE = /^[ \t]*\[hf:[^\]\n]*\][ \t]*$/gm;

/** Matches the token at the very end of a stored comment for the reader
 * algorithm (spec §5's "Reader algorithm" block) — anchored to end-of-string
 * (`\s*$`, no `m` flag) since a stored comment carries the token exactly
 * once, as the final line. */
const TOKEN_RE = /(?:^|\n)\[hf:([^\]\n]*)\]\s*$/;

/**
 * Removes every full-line `[hf:...]` look-alike from clerk-typed text, at
 * any position, and trailing-trims the result. This is the server's
 * anti-forgery step — call it on any incoming clerkText BEFORE composing
 * the stored comment (see appendAttribution below, which already does this
 * internally; exported separately so callers/tests can verify stripping in
 * isolation from the append step).
 */
export function stripForgedAttributionLines(clerkText: string): string {
  return clerkText.replace(FORGED_TOKEN_LINE_RE, "").replace(/\n{2,}/g, "\n").trim();
}

/**
 * Composes the stored comment for a create/modify write: strips any
 * forged/duplicate `[hf:...]` line from clerkText, trailing-trims it, then
 * appends the real token as the final line. `email` must already be the
 * lowercased, JWT-verified identity — never a client-supplied value.
 */
export function appendAttribution(clerkText: string, email: string): string {
  const cleaned = stripForgedAttributionLines(clerkText);
  const token = `[hf:by=${email}]`;
  return cleaned === "" ? token : `${cleaned}\n${token}`;
}

/** ezBookkeeping's transaction comment column caps at 255 runes upstream —
 * a FINAL stored comment (clerk text plus the appended attribution token)
 * over that limit gets a 400 from the engine itself. Runes here means JS
 * UTF-16 code units, which is exact for this app's content: Thai script and
 * hf email addresses both stay in the Basic Multilingual Plane (no
 * surrogate pairs), and this repo carries no emojis (see CLAUDE.md). */
export const ENGINE_COMMENT_MAX_RUNES = 255;

/** The length the FINAL stored comment would occupy once attribution is
 * appended — the exact same composition appendAttribution performs (M2
 * fix), without allocating the string, so the server can budget the
 * clerk-facing bound (COMMENT_MAX_LEN, a fixed guess) against the ACTUAL
 * caller email length at request time before ever calling the engine. A
 * long clerk comment paired with a long (e.g. LINE-synthetic) email can
 * exceed ENGINE_COMMENT_MAX_RUNES even while comfortably under
 * COMMENT_MAX_LEN alone. */
export function attributedCommentLength(clerkText: string, email: string): number {
  const cleaned = stripForgedAttributionLines(clerkText);
  const token = `[hf:by=${email}]`;
  return cleaned === "" ? token.length : cleaned.length + 1 + token.length;
}

export interface ParsedAttribution {
  /** Display text with the token stripped — what the client edits. */
  display: string;
  /** Lowercased email of the last writer, or null when the stored comment
   * carries no token (a legacy row predating this contract). */
  by: string | null;
}

/**
 * Reader algorithm (spec §5): splits the token's payload on `;` into k=v
 * pairs and reads `by`; unknown keys (the reserved extension slot) are
 * ignored rather than failing. A comment with no token reads back as-is,
 * with `by: null` — pre-contract rows must still read cleanly.
 */
export function parseAttribution(comment: string): ParsedAttribution {
  const match = TOKEN_RE.exec(comment);
  if (!match) return { display: comment, by: null };

  const payload = match[1] ?? "";
  let by: string | null = null;
  for (const pair of payload.split(";")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (key === "by" && value !== "") by = value;
    // Unknown keys (the reserved ;k=v extension slot) are ignored, not an
    // error — rule 7.
  }

  const display = comment.slice(0, match.index).replace(/\n$/, "");
  return { display, by };
}
