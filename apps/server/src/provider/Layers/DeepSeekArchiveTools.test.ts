/**
 * Slice D / H13 — `search_archives` ReDoS guard tests.
 *
 * Pins the regex safety check at the unit level so a future refactor
 * that loosens any leg of the check trips here before the weakened
 * behavior ships:
 *
 *   - `checkRegexSafety` rejects the exponential-class shape (nested
 *     unbounded quantifiers — `(a+)+`, `(a*)*`, `((b*))*`, etc.).
 *
 *   - Pattern length cap rejects oversized inputs at the wire,
 *     before any backtracking work has a chance to start.
 *
 *   - Bounded quantifiers (`?`, `{N}`, `{N,M}`) and the safe shapes
 *     (alternation without overlap, single-level repetition, char
 *     classes with quantifiers outside) are still accepted —
 *     otherwise the tool gets too useless to keep.
 *
 *   - Escapes / non-capturing prefixes / lookarounds / char classes
 *     are walked correctly (a literal `+` inside `\(...\)+` or
 *     `[a+]+` must not be counted as a regex quantifier on the
 *     surrounding parens).
 *
 * Note: we DO NOT compile the unsafe patterns inside these tests.
 * That's the point — the guard prevents them from ever reaching the
 * regex engine. Compiling `(a+)+` and `.test("aaaa...!")` here would
 * itself hang the test runner.
 */
import { describe, expect, it } from "vitest";

import {
  checkRegexSafety,
  SEARCH_ARCHIVES_MAX_SCAN_CHARS_PER_MESSAGE,
  SEARCH_ARCHIVES_REGEX_MAX_PATTERN_LENGTH,
} from "./DeepSeekArchiveTools.ts";

describe("Slice D — H13: search_archives regex safety constants", () => {
  it("SEARCH_ARCHIVES_REGEX_MAX_PATTERN_LENGTH is 200", () => {
    // Direct value pin. Generous enough for legitimate model-emitted
    // patterns (`\bfoo\b`, `^/api/v\\d+/users/[a-z0-9-]+$`, ...) but
    // tight enough that sprawling adversarial constructions get
    // refused at the door. Trip if loosened.
    expect(SEARCH_ARCHIVES_REGEX_MAX_PATTERN_LENGTH).toBe(200);
  });

  it("SEARCH_ARCHIVES_MAX_SCAN_CHARS_PER_MESSAGE is 32_768", () => {
    // 32 KB per message. Covers every legitimate conversation turn
    // we've seen in practice while bounding polynomial-class
    // backtracking work (the class star-height analysis cannot
    // catch). Trip if widened.
    expect(SEARCH_ARCHIVES_MAX_SCAN_CHARS_PER_MESSAGE).toBe(32_768);
  });
});

describe("Slice D — H13: checkRegexSafety accepts safe patterns", () => {
  const safe: ReadonlyArray<readonly [string, string]> = [
    ["simple literal", "hello"],
    ["bare quantifier on literal", "a+"],
    ["star on literal", "a*"],
    ["bounded quantifier", "a?"],
    ["exact-count quantifier", "a{5}"],
    ["bounded-range quantifier", "a{1,5}"],
    ["alternation without overlap", "foo|bar|baz"],
    ["single quantified group", "(abc)+"],
    ["char class with quantifier outside", "[a-zA-Z0-9]+"],
    ["digit shorthand quantified", "\\d+"],
    ["word boundary", "\\bfoo\\b"],
    ["anchored pattern", "^hello$"],
    ["non-capturing group quantified once", "(?:abc)+"],
    ["non-capturing group bounded quantifier on inner", "(?:a+)"],
    ["lookahead", "foo(?=bar)"],
    ["named capture group", "(?<name>\\w+)"],
    ["multiple separate quantified groups", "(a)+(b)+"],
    ["bounded outer over unbounded inner", "(a+){0,3}"],
    ["nested group without outer quantifier", "((a+))"],
    ["escaped paren is literal not group", "\\(a+\\)+"],
    ["quantifier inside char class is literal", "[a+]+"],
    ["non-greedy quantifier on literal", "a*?"],
  ];

  for (const [name, pattern] of safe) {
    it(`accepts ${name}: \`${pattern}\``, () => {
      const result = checkRegexSafety(pattern);
      expect(result).toEqual({ safe: true });
    });
  }
});

describe("Slice D — H13: checkRegexSafety rejects ReDoS-class patterns", () => {
  const unsafe: ReadonlyArray<readonly [string, string]> = [
    ["nested plus-plus", "(a+)+"],
    ["nested star-star", "(a*)*"],
    ["plus over star", "(a*)+"],
    ["star over plus", "(a+)*"],
    ["non-capturing nested", "(?:a+)+"],
    ["nested via two-level group", "((b*))*"],
    ["plus over alternation with star", "(a*b*)+"],
    ["unbounded {N,} over plus", "(a+){2,}"],
    ["plus over unbounded {N,}", "(a{0,})+"],
    ["plus on group containing unbounded inner group", "((\\d+))+"],
    ["digit-plus over digit-plus", "(\\d+)+"],
    ["the canonical email-validator ReDoS", "^(([a-zA-Z0-9])+)+$"],
  ];

  for (const [name, pattern] of unsafe) {
    it(`rejects ${name}: \`${pattern}\``, () => {
      const result = checkRegexSafety(pattern);
      expect(result.safe).toBe(false);
      if (!result.safe) {
        expect(result.reason).toMatch(/nested unbounded quantifier|ReDoS/i);
      }
    });
  }
});

describe("Slice D — H13: checkRegexSafety pattern length cap", () => {
  it("rejects empty pattern", () => {
    const result = checkRegexSafety("");
    expect(result.safe).toBe(false);
    if (!result.safe) expect(result.reason).toMatch(/empty/i);
  });

  it("accepts pattern at exactly the length cap", () => {
    // Boundary check — length === cap is fine.
    const atCap = "a".repeat(SEARCH_ARCHIVES_REGEX_MAX_PATTERN_LENGTH);
    expect(checkRegexSafety(atCap)).toEqual({ safe: true });
  });

  it("rejects pattern one char past the length cap", () => {
    const overCap = "a".repeat(SEARCH_ARCHIVES_REGEX_MAX_PATTERN_LENGTH + 1);
    const result = checkRegexSafety(overCap);
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.reason).toMatch(/too long/i);
    }
  });
});

describe("Slice D — H13: checkRegexSafety canonical hang-prevention", () => {
  it("rejects `(a+)+b` — the textbook exponential-ReDoS pattern", () => {
    // If this test ever fails open (returns `{ safe: true }`), the
    // tool would compile `(a+)+b` and call `.test()` against archived
    // content. A subsequent search over an attacker-controlled string
    // of `a`s would hang the event loop indefinitely. The H13 finding
    // would regress in a way that's invisible until exploited.
    //
    // We deliberately do NOT exercise `new RegExp("(a+)+b")` here —
    // that would prove the hang at the cost of hanging the test
    // runner. The static-check rejection is the load-bearing
    // guarantee.
    const result = checkRegexSafety("(a+)+b");
    expect(result.safe).toBe(false);
    if (!result.safe) {
      expect(result.reason).toMatch(/nested unbounded quantifier/i);
    }
  });

  it("rejects `(a*)*$` — anchored variant", () => {
    const result = checkRegexSafety("(a*)*$");
    expect(result.safe).toBe(false);
  });

  it("rejects deeply-nested `(((a+)+)+)+`", () => {
    // Multi-level nesting — caught at the innermost violation, so the
    // error message references the first nested pair found.
    const result = checkRegexSafety("(((a+)+)+)+");
    expect(result.safe).toBe(false);
  });
});
