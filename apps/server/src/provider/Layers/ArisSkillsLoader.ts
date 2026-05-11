/**
 * ArisSkillsLoader — discover and parse user-authored skills.
 *
 * Skills are markdown files with YAML-style frontmatter. The model can
 * invoke a skill via the `use_skill` tool (registered in 32b); the
 * loader's job is purely to find them on disk, parse them, and return
 * normalized records.
 *
 * Discovery roots:
 *   - Project: `<workspaceRoot>/.aris/skills/<name>/SKILL.md`
 *   - User:    `<userHome>/.aris/skills/<name>/SKILL.md`
 *
 * When a skill name appears in both project and user roots, the project
 * version wins. This mirrors the Claude Code precedence model and lets
 * a project override a user-global skill without forcing the user to
 * delete the global one.
 *
 * Why a hand-rolled frontmatter parser instead of `yaml` / `js-yaml`?
 *   - The skills format is narrow: scalars, inline arrays, block lists,
 *     booleans. No nested objects, no anchors, no tags.
 *   - Slice 32g introduces backtick shell substitution into frontmatter
 *     values — a generic YAML parser would resolve those as plain
 *     strings before we get a chance to interpolate, forcing us to
 *     post-process. Owning the parser keeps that path clean.
 *   - Zero new runtime dependencies.
 *
 * The parser is intentionally strict about what counts as frontmatter
 * (must open with `---` on the very first line) and lenient about what
 * it stores: unknown keys are preserved on the raw record so future
 * fields don't require a parser change. Typed accessors live in the
 * `SkillFrontmatter` interface and just read off the raw record.
 *
 * Hot reload (32i): the loader is called once per turn from
 * `ArisAdapter.runTurnStreaming`, which means edits to SKILL.md
 * files take effect on the very next user message — no session
 * restart needed. Add or rename a skill while a session is live
 * and Aris's `use_skill` tool description updates within seconds
 * of your save. No file watcher; the per-turn re-scan IS the
 * reload mechanism, and on a small skills directory it costs
 * negligibly.
 *
 * Bundled skills (32j): callers can pass `bundledSkills` to
 * `loadAllSkills`. Each entry is a fully-formed `Skill` object
 * shipped with the binary. Bundled skills sit at the LOWEST
 * precedence — both project and user can override by name —
 * which lets a host ship a baseline (e.g. `/help`, `/changelog`)
 * that the user is free to replace with their own version. The
 * scaffold is intentionally empty out of the box; t3code itself
 * ships zero bundled skills.
 *
 * @module ArisSkillsLoader
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Where a skill was discovered. Used by callers (precedence resolver,
 * UI affordances) to distinguish the three sources without inspecting
 * the path string.
 *
 *   - `project`: `<workspaceRoot>/.aris/skills/<name>/SKILL.md`
 *   - `user`:    `<userHome>/.aris/skills/<name>/SKILL.md`
 *   - `bundled`: ship-with-binary skill registered via
 *                `LoadSkillsOptions.bundledSkills` (32j). Lowest
 *                precedence; project and user can override by name.
 */
export type SkillSource = "project" | "user" | "bundled";

/**
 * Raw frontmatter record — the literal key→value pairs the parser
 * extracted, with original kebab-case keys preserved. Callers should
 * read through `SkillFrontmatter` for typed access; this is exposed for
 * forward-compat (unknown fields survive).
 */
export type RawFrontmatter = Readonly<Record<string, string | ReadonlyArray<string> | boolean>>;

/**
 * Typed view over `RawFrontmatter`. All fields optional — a SKILL.md is
 * valid with no frontmatter at all (the dir name supplies the skill
 * name and the body alone is the prompt). Field naming matches the
 * Claude Code skills doc (kebab-case in the file, camelCase in TS).
 */
export interface SkillFrontmatter {
  /** Canonical skill name. Defaults to the containing directory name. */
  readonly name?: string;
  /** One-line summary, surfaced in the use_skill tool description. */
  readonly description?: string;
  /**
   * Free-text guidance the model reads to decide when to invoke this
   * skill. The load-bearing field for model-driven dispatch.
   */
  readonly whenToUse?: string;
  /**
   * Free-text hint about what to pass as the skill's argument string.
   * Surfaced to the model alongside the tool schema.
   */
  readonly argumentHint?: string;
  /**
   * Optional list of named arguments the skill expects. Pure
   * documentation — the substitution logic itself reads
   * `$ARG_<NAME>` placeholders directly from the body and looks up
   * keys from the `key=value` tokens in the args string at dispatch
   * time. Declaring them here lets the use_skill tool description
   * surface the expected names so the model knows what to pass.
   */
  readonly arguments?: ReadonlyArray<string>;
  /**
   * Restrict the agent's available tool set to this list while the
   * skill is executing. Enforcement is 32d.
   */
  readonly allowedTools?: ReadonlyArray<string>;
  /** Model override for this skill's execution. Plumbing is 32f. */
  readonly model?: string;
  /** Reasoning effort override (e.g. "high"). Plumbing is 32f. */
  readonly effort?: string;
  /** Filesystem paths the skill is scoped to. Surfaced in 32d. */
  readonly paths?: ReadonlyArray<string>;
  /** When true, the skill cannot be invoked from non-interactive flows. */
  readonly disableNonInteractive?: boolean;
  /**
   * "inline" — skill prompt is appended to the current conversation.
   * "fork"   — skill runs as a sub-agent (fresh conversation), result
   *            returned as the parent skill's tool output. Sub-agent
   *            wiring is 32e.
   */
  readonly context?: "inline" | "fork";
  /** Sub-agent identifier for `context: fork`. Used in 32e. */
  readonly agent?: string;
  /** Original, non-normalized record. Useful for forward-compat. */
  readonly raw: RawFrontmatter;
}

/** A single discovered, parsed skill. */
export interface Skill {
  /** Canonical name — frontmatter `name` if present, else the directory name. */
  readonly name: string;
  /** Project precedence over user determined this slot. */
  readonly source: SkillSource;
  /** Absolute path to the SKILL.md file. */
  readonly filePath: string;
  /** Absolute path to the skill's directory (one level above SKILL.md). */
  readonly directory: string;
  readonly frontmatter: SkillFrontmatter;
  /** Markdown body, trimmed. The text the model receives on dispatch. */
  readonly body: string;
}

/** Non-fatal error encountered while loading a single skill file. */
export interface SkillLoadError {
  /** Best-effort path. May be a directory if we never reached the file. */
  readonly path: string;
  readonly source: SkillSource;
  readonly message: string;
}

export interface LoadSkillsOptions {
  /** Project root. If undefined, project discovery is skipped. */
  readonly workspaceRoot: string | undefined;
  /**
   * User home directory. If undefined, defaults to `os.homedir()`.
   * Pass `null` (not undefined) to explicitly skip user-scope discovery.
   */
  readonly userHome?: string | null | undefined;
  /**
   * Slice 32j — ship-with-binary skills. Each entry is a complete
   * `Skill` object that's merged into the result at the lowest
   * precedence. Project and user skills with the same name override
   * the bundled version. Useful for a host that wants to seed a
   * baseline (e.g. a `/help` or `/changelog` skill) without forcing
   * users to author their own — but they can still replace it.
   * Defaults to empty.
   */
  readonly bundledSkills?: ReadonlyArray<Skill>;
}

export interface LoadSkillsResult {
  /**
   * Skills after precedence resolution. At most one entry per canonical
   * name; if both project and user provide the same name, the project
   * entry wins and the user entry is dropped (silently — both sources
   * are intentional, not an error).
   */
  readonly skills: ReadonlyArray<Skill>;
  /**
   * Per-file parse / read errors. Loader is best-effort: a malformed
   * skill never blocks the rest of the directory.
   */
  readonly errors: ReadonlyArray<SkillLoadError>;
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

const FRONTMATTER_DELIMITER = /^---\s*$/;

/**
 * Result of `parseSkillFile`. Either the frontmatter-and-body pair we
 * extracted, or a non-fatal error string. Errors here surface as
 * `SkillLoadError` to the caller.
 */
export interface ParsedSkillFile {
  readonly frontmatter: SkillFrontmatter;
  readonly body: string;
}

/**
 * Parse the contents of a SKILL.md file. Recognizes:
 *
 *   - File starts with a `---` line: parse YAML-ish frontmatter until
 *     the next `---`, then treat the remainder as body.
 *   - File does not start with `---`: no frontmatter, the entire file
 *     is body.
 *
 * Returns `null` only on truly unrecoverable inputs (frontmatter opened
 * but never closed). Malformed individual lines are skipped silently —
 * the partial frontmatter is still returned so that one typo doesn't
 * disable the whole skill.
 */
export function parseSkillFile(content: string): ParsedSkillFile | null {
  const lines = content.split(/\r?\n/);
  if (lines.length === 0 || !FRONTMATTER_DELIMITER.test(lines[0]!)) {
    // No frontmatter — entire file is body.
    return {
      frontmatter: { raw: Object.freeze({}) },
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
    frontmatter: typedFrontmatter(raw),
    body: bodyLines.join("\n").trim(),
  };
}

/**
 * Parse the lines between the two `---` delimiters into a flat record.
 * Supports:
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
 */
function parseFrontmatterLines(
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
function parseScalarOrInlineArray(value: string): string | string[] | boolean {
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

function stripQuotes(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/**
 * Project a raw record into the typed `SkillFrontmatter` view. Unknown
 * keys are preserved on `.raw` for forward-compat. Type coercion is
 * conservative: an array-shaped value never becomes a scalar field, a
 * scalar never becomes an array field — mismatched types produce
 * `undefined` for that field rather than a partial value.
 */
// Type-narrowing helpers — hoisted to module scope so the lint rule
// (consistent-function-scoping) is satisfied and so they're cheap to
// reuse if other parsers want them later.
const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

const asBoolean = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

const asStringArray = (v: unknown): ReadonlyArray<string> | undefined => {
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) return Object.freeze([...v]);
  return undefined;
};

function typedFrontmatter(raw: Record<string, string | string[] | boolean>): SkillFrontmatter {
  // Freeze the raw side so callers can't accidentally mutate it.
  const frozen = Object.freeze({ ...raw }) as RawFrontmatter;
  const contextValue = asString(raw["context"]);
  const context: "inline" | "fork" | undefined =
    contextValue === "inline" || contextValue === "fork" ? contextValue : undefined;

  // Conditional spread is required because tsconfig has
  // `exactOptionalPropertyTypes: true` — a `name?: string` field cannot
  // hold `undefined`, only string-or-absent. Building the object with
  // omitted-when-undefined fields is the idiomatic pattern.
  const name = asString(raw["name"]);
  const description = asString(raw["description"]);
  const whenToUse = asString(raw["when-to-use"]);
  const argumentHint = asString(raw["argument-hint"]);
  const allowedTools = asStringArray(raw["allowed-tools"]);
  const model = asString(raw["model"]);
  const effort = asString(raw["effort"]);
  const paths = asStringArray(raw["paths"]);
  const disableNonInteractive = asBoolean(raw["disableNonInteractive"]);
  const agent = asString(raw["agent"]);
  const argumentsList = asStringArray(raw["arguments"]);

  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(whenToUse !== undefined ? { whenToUse } : {}),
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    ...(argumentsList !== undefined ? { arguments: argumentsList } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(paths !== undefined ? { paths } : {}),
    ...(disableNonInteractive !== undefined ? { disableNonInteractive } : {}),
    ...(context !== undefined ? { context } : {}),
    ...(agent !== undefined ? { agent } : {}),
    raw: frozen,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const SKILL_FILENAME = "SKILL.md";
const SKILLS_SUBDIR = path.join(".aris", "skills");

/**
 * Resolve the per-source skills root. Returns `null` when the source
 * is not configured (e.g. workspaceRoot undefined or userHome === null).
 */
function resolveSkillsRoot(opts: LoadSkillsOptions, source: SkillSource): string | null {
  if (source === "project") {
    return opts.workspaceRoot ? path.join(opts.workspaceRoot, SKILLS_SUBDIR) : null;
  }
  // user
  if (opts.userHome === null) return null;
  const home = opts.userHome ?? os.homedir();
  if (!home) return null;
  return path.join(home, SKILLS_SUBDIR);
}

/**
 * Enumerate `<root>/<name>/SKILL.md` candidate files, ignoring entries
 * that aren't directories. Returns absolute paths and any non-fatal
 * error encountered while reading the root. A missing root is not an
 * error — callers expect `[]` when skills haven't been set up. Other
 * errors (permission denied, I/O failure) are reported as a single
 * synthetic SkillLoadError on the root path so the overall loader
 * never rejects.
 */
async function enumerateSkillFiles(
  root: string,
  source: SkillSource,
): Promise<{ files: string[]; errors: SkillLoadError[] }> {
  let entries: string[];
  try {
    entries = await fs.readdir(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { files: [], errors: [] };
    return {
      files: [],
      errors: [
        {
          path: root,
          source,
          message: `Failed to read skills root: ${describeError(err)}`,
        },
      ],
    };
  }
  const found: string[] = [];
  for (const entry of entries) {
    const dir = path.join(root, entry);
    let stat;
    try {
      stat = await fs.stat(dir);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;
    found.push(path.join(dir, SKILL_FILENAME));
  }
  return { files: found.toSorted(), errors: [] };
}

async function loadSkillsFromRoot(
  root: string,
  source: SkillSource,
): Promise<{ skills: Skill[]; errors: SkillLoadError[] }> {
  const enumeration = await enumerateSkillFiles(root, source);
  const files = enumeration.files;
  const skills: Skill[] = [];
  const errors: SkillLoadError[] = [...enumeration.errors];

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Directory without a SKILL.md — silently skip. Authors may
        // create the dir before the file, no need to nag.
        continue;
      }
      errors.push({
        path: filePath,
        source,
        message: `Failed to read SKILL.md: ${describeError(err)}`,
      });
      continue;
    }

    const parsed = parseSkillFile(content);
    if (!parsed) {
      errors.push({
        path: filePath,
        source,
        message: "Frontmatter delimiter '---' opened but never closed.",
      });
      continue;
    }

    const directory = path.dirname(filePath);
    const fallbackName = path.basename(directory);
    const name = parsed.frontmatter.name ?? fallbackName;
    if (!name) {
      errors.push({
        path: filePath,
        source,
        message: "Skill has no name (empty directory and no `name:` frontmatter field).",
      });
      continue;
    }
    skills.push({
      name,
      source,
      filePath,
      directory,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  }
  return { skills, errors };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Discover and parse all skills across project and user roots.
 *
 * Precedence: when a skill name appears in both roots, the project
 * version wins. The user version is dropped from the returned list
 * silently — overriding is the intended pattern, not an error.
 *
 * Errors from individual files are aggregated into `errors` and never
 * thrown. The result is always usable: a single malformed SKILL.md
 * doesn't block the rest of the user's library.
 */
export async function loadAllSkills(opts: LoadSkillsOptions): Promise<LoadSkillsResult> {
  const projectRoot = resolveSkillsRoot(opts, "project");
  const userRoot = resolveSkillsRoot(opts, "user");

  const [project, user] = await Promise.all([
    projectRoot
      ? loadSkillsFromRoot(projectRoot, "project")
      : Promise.resolve({ skills: [], errors: [] }),
    userRoot ? loadSkillsFromRoot(userRoot, "user") : Promise.resolve({ skills: [], errors: [] }),
  ]);

  // Precedence ladder (highest → lowest): project > user > bundled.
  // Build the result by walking from highest down, dropping entries
  // whose name has already been claimed. Bundled lives at the bottom
  // so a host can ship a baseline that users freely override.
  const claimed = new Set<string>();
  const merged: Skill[] = [];
  for (const skill of project.skills) {
    claimed.add(skill.name);
    merged.push(skill);
  }
  for (const skill of user.skills) {
    if (claimed.has(skill.name)) continue;
    claimed.add(skill.name);
    merged.push(skill);
  }
  for (const skill of opts.bundledSkills ?? []) {
    if (claimed.has(skill.name)) continue;
    claimed.add(skill.name);
    merged.push(skill);
  }

  return {
    skills: Object.freeze(merged) as ReadonlyArray<Skill>,
    errors: Object.freeze([...project.errors, ...user.errors]) as ReadonlyArray<SkillLoadError>,
  };
}
