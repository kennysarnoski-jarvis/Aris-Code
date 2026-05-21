/**
 * MarkdownFrontmatterParser — pure parsing of YAML-ish frontmatter
 * blocks at the head of markdown files. Extracted from
 * `ArisSkillsLoader` (Slice 2 — 2026-05-16) so multiple loaders can
 * share the same dialect without copying the parsing logic.
 *
 * Used by:
 *   - `ArisSkillsLoader` — `.aris/skills/<name>/SKILL.md` files.
 *   - (Slice 3) `ArisAgentTemplatesLoader` — `.aris/agents/<name>/AGENT.md`
 *     files. Same frontmatter dialect, different typed projection.
 *
 * Dialect overview:
 *   - File starts with `---` on the very first line: parse YAML-ish
 *     frontmatter until the next `---`, then treat the remainder as
 *     body.
 *   - No leading `---`: no frontmatter, the entire file is body.
 *   - Recognized value shapes inside frontmatter:
 *       - `key: value`                  → string
 *       - `key: "quoted"` / `'quoted'`  → string (quotes stripped)
 *       - `key: true | false | yes | no` (case-insensitive) → boolean
 *       - `key: [a, b, "c, d"]`         → string[] (inline JSON-ish)
 *       - `key:\n  - item1\n  - item2`  → string[] (block-list)
 *   - Blank lines and `#`-prefixed comments inside frontmatter are
 *     ignored.
 *   - Malformed individual lines are skipped silently — one typo
 *     doesn't disable the whole frontmatter block.
 *   - Frontmatter that opens with `---` but never closes returns
 *     `null` (caller treats it as a hard error).
 *
 * Why hand-rolled vs `yaml` / `js-yaml`:
 *   - Frontmatter shape here is narrow (scalars, inline arrays,
 *     block lists, booleans). Full YAML compliance is overkill.
 *   - Skill frontmatter (Slice 32g) supports backtick shell
 *     substitution that a generic YAML parser would resolve as plain
 *     strings before our expansion layer gets a chance to interpolate.
 *     Owning the parser keeps that path clean.
 *   - Zero new runtime dependencies.
 *
 * Type-narrowing helpers (`asString`, `asBoolean`, `asStringArray`)
 * are exported alongside the parser so consumer modules can project
 * raw records into typed views without duplicating the type-coercion
 * logic.
 *
 * @module MarkdownFrontmatterParser
 */

/**
 * Raw frontmatter record — the literal key→value pairs the parser
 * extracted, with original kebab-case keys preserved. Frozen for
 * safety. Consumers project this into a typed view via their own
 * domain-specific helpers (e.g. `ArisSkillsLoader.typedFrontmatter`).
 */
export type RawFrontmatter = Readonly<Record<string, string | ReadonlyArray<string> | boolean>>;

/**
 * Successful parse result: the frozen raw frontmatter record and the
 * trimmed body text. `null` from the parser indicates an unrecoverable
 * shape (e.g. frontmatter opened but never closed).
 */
export interface MarkdownWithFrontmatter {
  readonly rawFrontmatter: RawFrontmatter;
  readonly body: string;
}

const FRONTMATTER_DELIMITER = /^---\s*$/;

/**
 * Parse a markdown string with optional YAML-ish frontmatter into
 * `{ rawFrontmatter, body }`. Returns `null` when frontmatter is
 * opened but never closed — that's a hard error, distinguishable from
 * "no frontmatter present" which returns
 * `{ rawFrontmatter: {}, body: <trimmed content> }`.
 *
 * Behavior is bit-for-bit identical to the previous inline
 * `parseSkillFile` implementation (Slice 2 extraction was a pure move,
 * no logic change). Consumer-side typing (which fields are recognized)
 * lives in the consumer loader's projection function.
 */
export function parseMarkdownWithFrontmatter(content: string): MarkdownWithFrontmatter | null {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || !FRONTMATTER_DELIMITER.test(lines[0]!)) {
    // No frontmatter — entire file is body.
    return {
      rawFrontmatter: Object.freeze({}) as RawFrontmatter,
      body: content.trim(),
    };
  }

  // Find the closing delimiter, skipping the opening one.
  let closingIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (FRONTMATTER_DELIMITER.test(lines[i]!)) {
      closingIndex = i;
      break;
    }
  }
  if (closingIndex === -1) {
    // Opened but never closed — treat as malformed, refuse to load.
    return null;
  }

  const fmLines = lines.slice(1, closingIndex);
  const bodyLines = lines.slice(closingIndex + 1);
  const raw = parseFrontmatterLines(fmLines);
  return {
    rawFrontmatter: Object.freeze({ ...raw }) as RawFrontmatter,
    body: bodyLines.join("\n").trim(),
  };
}

/**
 * Parse the lines between the two `---` delimiters into a flat
 * mutable record. Supports:
 *
 *   - `key: value`                     → string
 *   - `key: "quoted"` or `'quoted'`    → string (quotes stripped)
 *   - `key: true | false | yes | no`   → boolean
 *   - `key: [a, b, "c"]`               → string[] (inline JSON-ish array)
 *   - `key:\n  - item1\n  - item2`     → string[] (block-list)
 *   - blank lines and `#` comments     → ignored
 *
 * Block-list items continue while subsequent lines are indented and
 * start with `- `. Indentation is tracked relative to the list's first
 * `- ` line, not absolute, to be forgiving about author tab/space mixes.
 *
 * Unknown / malformed lines are skipped. The goal is "extract what we
 * can" — strict YAML compliance is out of scope.
 *
 * Exported for testing / advanced consumers that already have the
 * frontmatter lines isolated. Most callers want
 * `parseMarkdownWithFrontmatter` which wraps this in delimiter
 * detection + freezing.
 */
export function parseFrontmatterLines(
  lines: ReadonlyArray<string>,
): Record<string, string | string[] | boolean> {
  const record: Record<string, string | string[] | boolean> = {};
  let i = 0;
  while (i < lines.length) {
    const raw = lines[i]!;
    const line = raw.trimEnd();
    const trimmed = line.trim();

    // Skip blanks and comments.
    if (trimmed === "" || trimmed.startsWith("#")) {
      i += 1;
      continue;
    }

    // Match `key:` or `key: value`.
    const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/.exec(line);
    if (!match) {
      i += 1;
      continue;
    }
    const key = match[1]!;
    const rest = match[2] ?? "";

    if (rest === "") {
      // Possibly a block list — peek ahead.
      const collected: string[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const next = lines[j]!;
        const nextTrimmed = next.trim();
        if (nextTrimmed === "" || nextTrimmed.startsWith("#")) {
          j += 1;
          continue;
        }
        // Block-list item must start with whitespace + "- ".
        const itemMatch = /^\s+-\s+(.*)$/.exec(next);
        if (!itemMatch) break;
        collected.push(stripQuotes(itemMatch[1]!.trim()));
        j += 1;
      }
      if (collected.length > 0) {
        record[key] = collected;
        i = j;
        continue;
      }
      // No block-list items found → treat as empty string value.
      record[key] = "";
      i += 1;
      continue;
    }

    record[key] = parseScalarOrInlineArray(rest);
    i += 1;
  }
  return record;
}

/**
 * Parse a value-side token. Recognizes inline arrays (`[a, b]`),
 * booleans (`true|false|yes|no`, case-insensitive), and quoted strings.
 * Anything else falls through as a plain trimmed string.
 */
export function parseScalarOrInlineArray(value: string): string | string[] | boolean {
  const trimmed = value.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    // Inline array. Split on commas, but respect quoted strings so
    // `[a, "b, c", d]` yields ["a", "b, c", "d"]. Hand-rolled because
    // a regex split would either over- or under-segment the quoted case.
    const inner = trimmed.slice(1, -1);
    const items: string[] = [];
    let buf = "";
    let inQuote: '"' | "'" | null = null;
    for (let i = 0; i < inner.length; i += 1) {
      const ch = inner[i]!;
      if (inQuote) {
        if (ch === inQuote) inQuote = null;
        else buf += ch;
        continue;
      }
      if (ch === '"' || ch === "'") {
        inQuote = ch;
        continue;
      }
      if (ch === ",") {
        items.push(buf.trim());
        buf = "";
        continue;
      }
      buf += ch;
    }
    if (buf.trim() !== "" || items.length > 0) items.push(buf.trim());
    return items.filter((s) => s.length > 0);
  }

  const lower = trimmed.toLowerCase();
  if (lower === "true" || lower === "yes") return true;
  if (lower === "false" || lower === "no") return false;

  return stripQuotes(trimmed);
}

/** Strip matching outer quotes from a value, if present. */
export function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

// ---------------------------------------------------------------------------
// Type-narrowing helpers
//
// Hoisted to module scope so the lint rule (consistent-function-scoping) is
// satisfied and so they're cheap to reuse across consumer loaders.
// Each helper returns `undefined` on type mismatch rather than throwing —
// callers building typed projections can use this with optional-field
// idioms (`...(value !== undefined ? { field: value } : {})`) under
// `exactOptionalPropertyTypes: true`.
// ---------------------------------------------------------------------------

/** Narrow `unknown` to a non-empty string, else `undefined`. */
export const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/** Narrow `unknown` to a boolean, else `undefined`. */
export const asBoolean = (v: unknown): boolean | undefined =>
  typeof v === "boolean" ? v : undefined;

/**
 * Narrow `unknown` to a frozen string array, else `undefined`. The
 * returned array is a defensive copy so callers can't mutate the
 * parser's internal state by holding onto the reference.
 */
export const asStringArray = (v: unknown): ReadonlyArray<string> | undefined => {
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return Object.freeze([...v]);
  return undefined;
};

/**
 * Narrow `unknown` to a finite integer, else `undefined`.
 *
 * The hand-rolled frontmatter parser stores all scalar values as
 * strings (it doesn't distinguish `key: 50` from `key: "50"` — both
 * land as the string "50"). Consumers that need numeric fields use
 * this helper to coerce the string at typed-projection time.
 *
 * Coercion rules:
 *   - String form: `/^-?\d+$/` → parseInt → integer if finite.
 *   - Already a number: returned only if Number.isInteger(v).
 *   - Anything else (decimal "1.5", non-digit chars, +/- only): `undefined`.
 *
 * Floats are intentionally rejected — every numeric field we surface
 * today is an integer count (max_turns, max_tokens, retry counts).
 * If a future field genuinely needs a float, add a sibling
 * `asNumber` helper rather than loosening this one.
 */
export const asInteger = (v: unknown): number | undefined => {
  if (typeof v === "number") return Number.isInteger(v) ? v : undefined;
  if (typeof v === "string" && /^-?\d+$/.test(v)) {
    const n = Number.parseInt(v, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
};
