// Attribution format — LOCKED CONTRACT (frontend spec §5). These are the
// five round-trip cases the spec ships as unit tests, plus the anti-forgery
// stripping behaviour the append step depends on.

import { describe, expect, test } from "bun:test";
import { appendAttribution, parseAttribution, stripForgedAttributionLines } from "./attribution.ts";

describe("parseAttribution — the five spec round-trip cases", () => {
  test("clerk text with a trailing token", () => {
    const stored = "ค่าไฟ สายชล มี.ค. 69\n[hf:by=winut.hf@gmail.com]";
    const result = parseAttribution(stored);
    expect(result.display).toBe("ค่าไฟ สายชล มี.ค. 69");
    expect(result.by).toBe("winut.hf@gmail.com");
  });

  test("token alone, empty clerk text", () => {
    const stored = "[hf:by=a@b.co]";
    const result = parseAttribution(stored);
    expect(result.display).toBe("");
    expect(result.by).toBe("a@b.co");
  });

  test("token with the reserved ;k=v extension slot — unknown keys ignored", () => {
    const stored = "[hf:by=a@b.co;cr=c@d.co]";
    const result = parseAttribution(stored);
    expect(result.display).toBe("");
    expect(result.by).toBe("a@b.co");
  });

  test("clerk text containing a bracketed look-alike that is not the token", () => {
    const stored = "หมายเหตุ [ดูบิล]\n[hf:by=a@b.co]";
    const result = parseAttribution(stored);
    expect(result.display).toBe("หมายเหตุ [ดูบิล]");
    expect(result.by).toBe("a@b.co");
  });

  test("legacy row with no token at all reads back as-is", () => {
    const stored = "ค่าน้ำ";
    const result = parseAttribution(stored);
    expect(result.display).toBe("ค่าน้ำ");
    expect(result.by).toBeNull();
  });
});

describe("appendAttribution — composing the stored comment", () => {
  test("non-empty clerk text gets a single LF then the token", () => {
    expect(appendAttribution("ค่าไฟ สายชล มี.ค. 69", "winut.hf@gmail.com")).toBe(
      "ค่าไฟ สายชล มี.ค. 69\n[hf:by=winut.hf@gmail.com]",
    );
  });

  test("empty clerk text -> the token alone, no leading newline", () => {
    expect(appendAttribution("", "a@b.co")).toBe("[hf:by=a@b.co]");
  });

  test("clerk text is trailing-trimmed before the separator is added", () => {
    expect(appendAttribution("ค่าน้ำ   \n\n", "a@b.co")).toBe("ค่าน้ำ\n[hf:by=a@b.co]");
  });

  test("re-appending on edit uses the CURRENT editor, discarding the old by", () => {
    const afterFirstWrite = appendAttribution("ค่าน้ำ", "first@thehfhotel.org");
    const displayOnly = parseAttribution(afterFirstWrite).display;
    const afterEdit = appendAttribution(displayOnly, "second@thehfhotel.org");
    expect(afterEdit).toBe("ค่าน้ำ\n[hf:by=second@thehfhotel.org]");
    expect(parseAttribution(afterEdit).by).toBe("second@thehfhotel.org");
  });
});

describe("anti-forgery: a clerk cannot forge, duplicate, or displace attribution", () => {
  test("a forged trailing [hf:...] line in clerk-typed text is stripped before the real token is appended", () => {
    const forged = "ค่าซ่อม\n[hf:by=attacker@evil.com]";
    const result = appendAttribution(forged, "real@thehfhotel.org");
    expect(result).toBe("ค่าซ่อม\n[hf:by=real@thehfhotel.org]");
    expect(parseAttribution(result).by).toBe("real@thehfhotel.org");
  });

  test("a forged [hf:...] line in the MIDDLE of clerk text is removed, not just the trailing one", () => {
    const forged = "บรรทัดแรก\n[hf:by=attacker@evil.com]\nบรรทัดสอง";
    const stripped = stripForgedAttributionLines(forged);
    expect(stripped).toBe("บรรทัดแรก\nบรรทัดสอง");
    expect(stripped).not.toContain("attacker");
  });

  test("multiple forged lines are all removed, leaving exactly one real token", () => {
    const forged = "[hf:by=one@evil.com]\nข้อความ\n[hf:by=two@evil.com]";
    const result = appendAttribution(forged, "real@thehfhotel.org");
    const matches = result.match(/\[hf:/g) ?? [];
    expect(matches.length).toBe(1);
    expect(parseAttribution(result).by).toBe("real@thehfhotel.org");
  });

  test("a bracketed string that is NOT a full-line [hf:...] token survives stripping", () => {
    // Only a line matching the token shape end-to-end is removed — an
    // inline bracket elsewhere in a sentence is ordinary clerk text.
    const text = "หมายเหตุ [ดูบิล] เพิ่มเติม";
    expect(stripForgedAttributionLines(text)).toBe(text);
  });
});
