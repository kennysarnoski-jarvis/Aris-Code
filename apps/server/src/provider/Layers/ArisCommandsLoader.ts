/**
 * ArisCommandsLoader — discover and parse user-authored slash commands.
 *
 * Commands are markdown files at `.aris/commands/<name>.md`. Two
 * dispatch surfaces, both honored:
 *   1. USER-driven: `/name args...` typed as the first thing in a
 *      message. `rewriteSlashCommand` matches against commands as a
 *      fallback after skills.
 *   2. MODEL-driven: the `use_command` tool (see `ArisCommandsTool.ts`)
 *      exposes the commands manifest to the model. When the user's
 *      intent matches a command's description, the model can invoke
 *      it autonomously the same way it invokes skills via `use_skill`.
 *
 * Why a parallel loader (not a `<name>.md` flag on the skills loader)?
 *   - Conceptual clarity: commands and skills are different surfaces.
 *     Skills are the rich surface (fork mode, `allowed-tools`,
 *     model/effort overrides, `when-to-use` field); commands are the
 *     lightweight surface (just `description` + `argument-hint`).
 *     Both are invokable by user AND model — what differs is the
 *     feature surface, not the dispatch model.
 *   - Layout difference: commands are flat (`<name>.md`), skills are
 *     directory-per-template (`<name>/SKILL.md`). The directory layout
 *     supports sidecar assets (hooks, scripts); commands typically don't
 *     need them. Flat layout matches the ECC convention we ported from.
 *   - Smaller surface: commands have only `description` and optionally
 *     `argument-hint`. No fork mode, no allowed-tools, no model/effort
 *     overrides — graduate to a skill if you need those.
 *
 * Discovery roots:
 *   - Project: `<workspaceRoot>/.aris/commands/<name>.md`
 *   - User:    `<userHome>/.aris/commands/<name>.md`
 *
 * Precedence (highest → lowest): project > user > bundled. Same as
 * skills and agent templates. Project shadows user shadows bundled by
 * canonical name (filename without `.md`).
 *
 * Hot reload: callers re-invoke `loadAllCommands` per turn (mirrors the
 * skills loader's `runTurnStreaming` integration). Add or rename a
 * command file and the next user message picks it up.
 *
 * @module ArisCommandsLoader
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  asString,
  asStringArray,
  parseMarkdownWithFrontmatter,
  type RawFrontmatter,
} from "./MarkdownFrontmatterParser.ts";

// Re-export RawFrontmatter so consumers don't need to chase the dependency.
export type { RawFrontmatter };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Where a command was discovered. Mirrors `SkillSource` and
 * `AgentTemplateSource` for symmetry.
 *
 *   - `project`: `<workspaceRoot>/.aris/commands/<name>.md`
 *   - `user`:    `<userHome>/.aris/commands/<name>.md`
 *   - `bundled`: ship-with-binary command registered via
 *                `LoadCommandsOptions.bundledCommands`. Lowest
 *                precedence; project and user override by name.
 */
export type CommandSource = "project" | "user" | "bundled";

/**
 * Typed view over `RawFrontmatter` for a command file. All fields
 * optional — a command file is valid with no frontmatter at all (the
 * filename supplies the canonical name and the body alone is the
 * dispatch payload). Field naming mirrors the skills/agents convention:
 * kebab-case in the file, camelCase in TS.
 *
 * Recognized fields:
 *   - `description`  — one-line summary. Surfaced in the slash-command
 *                      picker UI (when Aris's composer renders command
 *                      suggestions) and the per-command help affordance.
 *   - `argument-hint` — free-text hint about what arguments the
 *                      command accepts. Surfaced inline in the
 *                      composer as the user is typing.
 *   - `arguments`    — optional declarative list of named arguments
 *                      the command body references via `$ARG_<NAME>`
 *                      placeholders. Pure documentation; substitution
 *                      itself is driven by the actual placeholders in
 *                      the body at dispatch time.
 *
 * `name` is intentionally NOT in the typed view — the filename is the
 * canonical name (no override semantics). If a frontmatter `name`
 * field is present it's preserved on `.raw` but ignored by the loader.
 */
export interface CommandFrontmatter {
  readonly description?: string;
  readonly argumentHint?: string;
  readonly arguments?: ReadonlyArray<string>;
  /** Original, non-normalized record. Useful for forward-compat. */
  readonly raw: RawFrontmatter;
}

/** A single discovered, parsed command. */
export interface Command {
  /** Canonical name — derived from the filename (no `.md` extension). */
  readonly name: string;
  /** Source root precedence resolved this slot. */
  readonly source: CommandSource;
  /** Absolute path to the `<name>.md` file. */
  readonly filePath: string;
  readonly frontmatter: CommandFrontmatter;
  /**
   * Markdown body, trimmed. This is the text dispatched as the user's
   * rewritten message when they type `/<name>`. The slash-command
   * dispatch path applies `$ARGUMENTS` + `$ARG_<NAME>` substitution
   * before the body reaches the model.
   */
  readonly body: string;
}

/** Non-fatal error encountered while loading a single command file. */
export interface CommandLoadError {
  /** Best-effort path. May be a directory if we never reached the file. */
  readonly path: string;
  readonly source: CommandSource;
  readonly message: string;
}

export interface LoadCommandsOptions {
  /** Project root. If undefined, project discovery is skipped. */
  readonly workspaceRoot: string | undefined;
  /**
   * User home directory. If undefined, defaults to `os.homedir()`.
   * Pass `null` (not undefined) to explicitly skip user-scope discovery.
   */
  readonly userHome?: string | null | undefined;
  /**
   * Ship-with-binary commands. Each entry is a complete `Command`
   * object merged at the lowest precedence. Project and user commands
   * with the same name override the bundled version. Defaults to empty.
   */
  readonly bundledCommands?: ReadonlyArray<Command>;
}

export interface LoadCommandsResult {
  /**
   * Commands after precedence resolution. At most one entry per
   * canonical name; if multiple roots provide the same name, the
   * higher-precedence entry wins and lower ones are dropped silently.
   */
  readonly commands: ReadonlyArray<Command>;
  /**
   * Per-file parse / read errors. Loader is best-effort: a malformed
   * command never blocks the rest of the directory.
   */
  readonly errors: ReadonlyArray<CommandLoadError>;
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

export interface ParsedCommandFile {
  readonly frontmatter: CommandFrontmatter;
  readonly body: string;
}

/**
 * Parse the contents of a command `.md` file. Thin wrapper over the
 * shared `parseMarkdownWithFrontmatter` that applies the
 * command-specific typed projection. Returns `null` on unclosed
 * frontmatter — the loader surfaces this as a `CommandLoadError`.
 */
export function parseCommandFile(content: string): ParsedCommandFile | null {
  const parsed = parseMarkdownWithFrontmatter(content);
  if (parsed === null) return null;
  return {
    frontmatter: typedCommandFrontmatter(parsed.rawFrontmatter),
    body: parsed.body,
  };
}

function typedCommandFrontmatter(raw: RawFrontmatter): CommandFrontmatter {
  const description = asString(raw["description"]);
  const argumentHint = asString(raw["argument-hint"]);
  const argumentsList = asStringArray(raw["arguments"]);

  return {
    ...(description !== undefined ? { description } : {}),
    ...(argumentHint !== undefined ? { argumentHint } : {}),
    ...(argumentsList !== undefined ? { arguments: argumentsList } : {}),
    raw,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const COMMANDS_SUBDIR = path.join(".aris", "commands");
const COMMAND_EXT = ".md";

/**
 * Resolve the per-source commands root. Returns `null` when the source
 * is not configured (workspaceRoot undefined or userHome === null).
 */
function resolveCommandsRoot(opts: LoadCommandsOptions, source: CommandSource): string | null {
  if (source === "project") {
    return opts.workspaceRoot ? path.join(opts.workspaceRoot, COMMANDS_SUBDIR) : null;
  }
  // user
  if (opts.userHome === null) return null;
  const home = opts.userHome ?? os.homedir();
  if (!home) return null;
  return path.join(home, COMMANDS_SUBDIR);
}

/**
 * Enumerate `<root>/<name>.md` candidate files, ignoring entries that
 * aren't `.md` regular files. A missing root is not an error — callers
 * expect `[]` when commands haven't been set up. Other errors are
 * reported on the root path so the overall loader never rejects.
 */
async function enumerateCommandFiles(
  root: string,
  source: CommandSource,
): Promise<{ files: string[]; errors: CommandLoadError[] }> {
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
          message: `Failed to read commands root: ${describeError(err)}`,
        },
      ],
    };
  }
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(COMMAND_EXT)) continue;
    const filePath = path.join(root, entry);
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    found.push(filePath);
  }
  return { files: found.toSorted(), errors: [] };
}

async function loadCommandsFromRoot(
  root: string,
  source: CommandSource,
): Promise<{ commands: Command[]; errors: CommandLoadError[] }> {
  const enumeration = await enumerateCommandFiles(root, source);
  const files = enumeration.files;
  const commands: Command[] = [];
  const errors: CommandLoadError[] = [...enumeration.errors];

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Race: file deleted between readdir and readFile. Skip silently.
        continue;
      }
      errors.push({
        path: filePath,
        source,
        message: `Failed to read command file: ${describeError(err)}`,
      });
      continue;
    }

    const parsed = parseCommandFile(content);
    if (!parsed) {
      errors.push({
        path: filePath,
        source,
        message: "Frontmatter delimiter '---' opened but never closed.",
      });
      continue;
    }

    const name = path.basename(filePath, COMMAND_EXT);
    if (name.length === 0) {
      errors.push({
        path: filePath,
        source,
        message: "Command filename resolved to an empty name; skipping.",
      });
      continue;
    }

    commands.push({
      name,
      source,
      filePath,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  }
  return { commands, errors };
}

// ---------------------------------------------------------------------------
// Precedence
// ---------------------------------------------------------------------------

/**
 * Merge commands from project, user, and bundled sources applying
 * precedence (project > user > bundled). At most one entry per
 * canonical name survives.
 */
function resolvePrecedence(
  project: ReadonlyArray<Command>,
  user: ReadonlyArray<Command>,
  bundled: ReadonlyArray<Command>,
): Command[] {
  const byName = new Map<string, Command>();
  // Insertion order is lowest-to-highest precedence; later inserts
  // overwrite earlier. This mirrors the skills loader's pattern.
  for (const c of bundled) byName.set(c.name, c);
  for (const c of user) byName.set(c.name, c);
  for (const c of project) byName.set(c.name, c);
  return Array.from(byName.values()).toSorted((a, b) => a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Load all commands from project + user roots, applying precedence
 * against any bundled commands. Best-effort: per-file errors collect
 * into `result.errors` but the loader never rejects.
 */
export async function loadAllCommands(opts: LoadCommandsOptions): Promise<LoadCommandsResult> {
  const projectRoot = resolveCommandsRoot(opts, "project");
  const userRoot = resolveCommandsRoot(opts, "user");

  const [projectLoad, userLoad] = await Promise.all([
    projectRoot
      ? loadCommandsFromRoot(projectRoot, "project")
      : Promise.resolve({ commands: [] as Command[], errors: [] as CommandLoadError[] }),
    userRoot
      ? loadCommandsFromRoot(userRoot, "user")
      : Promise.resolve({ commands: [] as Command[], errors: [] as CommandLoadError[] }),
  ]);

  const commands = resolvePrecedence(
    projectLoad.commands,
    userLoad.commands,
    opts.bundledCommands ?? [],
  );

  return {
    commands,
    errors: [...projectLoad.errors, ...userLoad.errors],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
