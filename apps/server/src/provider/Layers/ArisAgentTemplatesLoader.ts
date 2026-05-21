/**
 * ArisAgentTemplatesLoader — discover and parse user-authored agent
 * templates.
 *
 * Agent templates are markdown files at `.aris/agents/<name>/AGENT.md`
 * that define a pre-baked sub-agent worker the coordinator can spawn
 * by name via `spawn_worker({ template: "<name>", prompt: "..." })`.
 * Each template's body is the worker's system prompt; frontmatter
 * carries routing knobs (model, effort, allowed-tools, max-turns) the
 * spawn_worker tool applies as defaults when the coordinator names
 * the template.
 *
 * Slice 3 (2026-05-16) — this loader is the second consumer of
 * `MarkdownFrontmatterParser`. The frontmatter dialect is identical
 * to `.aris/skills/`'s SKILL.md, only the typed projection differs:
 * skills carry workflow-dispatch fields (whenToUse, argumentHint,
 * context: inline/fork), while agents carry sub-agent routing fields
 * (model, effort, allowed-tools, max-turns). The shared parser keeps
 * the two surfaces' parsing behavior in lock-step — same quoting
 * rules, same block-list shape, same comment handling.
 *
 * Discovery roots:
 *   - Project: `<workspaceRoot>/.aris/agents/<name>/AGENT.md`
 *   - User:    `<userHome>/.aris/agents/<name>/AGENT.md`
 *
 * Precedence (highest → lowest): project > user > bundled. When a
 * template name appears in multiple roots, the higher-precedence
 * source wins and lower ones are dropped silently — same model as
 * skills, same model as Claude Code, lets a project override a
 * user-global template without forcing the user to delete the global.
 *
 * Hot reload: callers re-invoke `loadAllAgentTemplates` per turn (the
 * `DeepSeekAdapter`'s `runTurnStreaming` path does this for skills;
 * Slice 4 wires the agent-templates equivalent the same way). Add or
 * rename an AGENT.md and the next turn picks it up — no session
 * restart needed.
 *
 * @module ArisAgentTemplatesLoader
 */
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  asInteger,
  asString,
  asStringArray,
  parseMarkdownWithFrontmatter,
  type RawFrontmatter,
} from "./MarkdownFrontmatterParser.ts";

// Re-export RawFrontmatter so consumers of this loader's types don't
// need to know which underlying module owns the type. Matches the
// pattern ArisSkillsLoader uses post-Slice-2.
export type { RawFrontmatter };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Where an agent template was discovered. Mirrors `SkillSource` —
 * same precedence ladder, same semantics, separate type because the
 * domain is different and we don't want a cross-import to bind the
 * two loaders.
 *
 *   - `project`: `<workspaceRoot>/.aris/agents/<name>/AGENT.md`
 *   - `user`:    `<userHome>/.aris/agents/<name>/AGENT.md`
 *   - `bundled`: ship-with-binary template registered via
 *                `LoadAgentTemplatesOptions.bundledTemplates`.
 *                Lowest precedence; project and user can override
 *                by name.
 */
export type AgentTemplateSource = "project" | "user" | "bundled";

/**
 * Typed view over `RawFrontmatter` for an AGENT.md file. All fields
 * optional — an AGENT.md is valid with no frontmatter at all (the
 * directory name supplies the template name and the body alone is the
 * worker's system prompt). Field naming mirrors the SKILL.md
 * convention (kebab-case in the file, camelCase in TS).
 *
 * Fields:
 *   - `name`         — canonical template name; defaults to the
 *                      containing directory name when omitted.
 *   - `description`  — one-line summary surfaced in the spawn_worker
 *                      tool's template manifest.
 *   - `model`        — DeepSeek model slug to route this template's
 *                      spawned workers through. Common picks:
 *                      `deepseek-v4-pro` (default, hard problems)
 *                      `deepseek-v4-flash` (cheap, mechanical work).
 *                      Validation against the canonical slug set
 *                      happens at spawn time in `spawn_worker`'s
 *                      Zod enum, NOT here — the loader stays loose
 *                      so a typo in frontmatter just surfaces a
 *                      clear error from spawn_worker rather than
 *                      dropping the template silently.
 *   - `effort`       — reasoning depth override (loose string;
 *                      gets coerced via `mapEffortToReasoningEffort`
 *                      in DeepSeekAdapter to `light | high | max`).
 *                      Stays as a string here for the same reason
 *                      as model — coercion happens at spawn time.
 *   - `allowedTools` — additive specialty tool list. Workers always
 *                      get the WORKER_BASELINE_TOOL_NAMES set
 *                      regardless of this field; declaring extras
 *                      here (`search_knowledge`, `search_cve`, etc.)
 *                      makes them available to the templated worker
 *                      without the coordinator having to remember
 *                      the names every spawn.
 *   - `maxTurns`     — override DEFAULT_WORKER_MAX_TURNS (currently 50).
 *                      Useful for deep-research templates that
 *                      legitimately need more iterations or for
 *                      narrow templates that should fail fast.
 */
export interface AgentTemplateFrontmatter {
  readonly name?: string;
  readonly description?: string;
  readonly model?: string;
  readonly effort?: string;
  readonly allowedTools?: ReadonlyArray<string>;
  readonly maxTurns?: number;
  /** Original, non-normalized record. Useful for forward-compat. */
  readonly raw: RawFrontmatter;
}

/** A single discovered, parsed agent template. */
export interface AgentTemplate {
  /** Canonical name — frontmatter `name` if present, else the directory name. */
  readonly name: string;
  /** Which root this template came from (precedence already applied). */
  readonly source: AgentTemplateSource;
  /** Absolute path to the AGENT.md file. */
  readonly filePath: string;
  /** Absolute path to the template's directory (one level above AGENT.md). */
  readonly directory: string;
  readonly frontmatter: AgentTemplateFrontmatter;
  /**
   * Markdown body, trimmed. This is the worker's system prompt — the
   * text handed to the spawned sub-agent as `instructions`. The
   * `DEFAULT_WORKER_INSTRUCTIONS` baseline (file/shell guidance,
   * confidence filter) is NOT appended automatically; templates that
   * want it should reference or quote it inline. Future Slice 4
   * may layer them; for V1 the template body fully replaces the
   * default instructions when present, matching how spawn_worker's
   * existing `system_prompt` override works.
   */
  readonly body: string;
}

/** Non-fatal error encountered while loading a single AGENT.md file. */
export interface AgentTemplateLoadError {
  /** Best-effort path. May be a directory if we never reached the file. */
  readonly path: string;
  readonly source: AgentTemplateSource;
  readonly message: string;
}

export interface LoadAgentTemplatesOptions {
  /** Project root. If undefined, project discovery is skipped. */
  readonly workspaceRoot: string | undefined;
  /**
   * User home directory. If undefined, defaults to `os.homedir()`.
   * Pass `null` (not undefined) to explicitly skip user-scope discovery.
   */
  readonly userHome?: string | null | undefined;
  /**
   * Ship-with-binary templates. Each entry is a complete
   * `AgentTemplate` object merged into the result at the lowest
   * precedence. Project and user templates with the same name
   * override the bundled version. Useful for a host that wants to
   * seed a baseline set (e.g. starter `code-reviewer` / `planner`)
   * without forcing users to author their own — but they can still
   * replace it. Defaults to empty.
   */
  readonly bundledTemplates?: ReadonlyArray<AgentTemplate>;
}

export interface LoadAgentTemplatesResult {
  /**
   * Templates after precedence resolution. At most one entry per
   * canonical name; if multiple roots provide the same name, the
   * higher-precedence entry wins and lower ones are dropped silently
   * (overriding is the intended pattern, not an error).
   */
  readonly templates: ReadonlyArray<AgentTemplate>;
  /**
   * Per-file parse / read errors. Loader is best-effort: a malformed
   * AGENT.md never blocks the rest of the directory.
   */
  readonly errors: ReadonlyArray<AgentTemplateLoadError>;
}

// ---------------------------------------------------------------------------
// Frontmatter parser
// ---------------------------------------------------------------------------

/**
 * Result of `parseAgentTemplateFile`. Either the frontmatter-and-body
 * pair we extracted, or `null` for unrecoverable shapes (frontmatter
 * opened but never closed). Non-fatal per-line errors are silently
 * skipped — same lenient stance as the skills parser.
 */
export interface ParsedAgentTemplateFile {
  readonly frontmatter: AgentTemplateFrontmatter;
  readonly body: string;
}

/**
 * Parse the contents of an AGENT.md file. Thin wrapper over the
 * shared `parseMarkdownWithFrontmatter` that applies the
 * agent-specific typed projection (`typedAgentTemplateFrontmatter`).
 * Returns `null` on unclosed frontmatter — the loader surfaces this
 * as an `AgentTemplateLoadError`.
 */
export function parseAgentTemplateFile(content: string): ParsedAgentTemplateFile | null {
  const parsed = parseMarkdownWithFrontmatter(content);
  if (parsed === null) return null;
  return {
    frontmatter: typedAgentTemplateFrontmatter(parsed.rawFrontmatter),
    body: parsed.body,
  };
}

/**
 * Project a raw record into the typed `AgentTemplateFrontmatter` view.
 * Unknown keys are preserved on `.raw` for forward-compat. Conservative
 * type coercion — a scalar never becomes an array field and vice-versa;
 * mismatched types produce `undefined` for that field rather than a
 * partial value. The `max-turns` field is coerced via `asInteger`,
 * which accepts numeric-string form (the frontmatter parser stores
 * all scalars as strings) but rejects floats and non-digit input.
 */
function typedAgentTemplateFrontmatter(raw: RawFrontmatter): AgentTemplateFrontmatter {
  // Conditional spread under `exactOptionalPropertyTypes: true` — a
  // `name?: string` field can hold string-or-absent but not
  // string-or-undefined. Building the object with omitted-when-undefined
  // fields is the idiomatic pattern.
  const name = asString(raw["name"]);
  const description = asString(raw["description"]);
  const model = asString(raw["model"]);
  const effort = asString(raw["effort"]);
  const allowedTools = asStringArray(raw["allowed-tools"]);
  const maxTurns = asInteger(raw["max-turns"]);

  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(maxTurns !== undefined ? { maxTurns } : {}),
    // `raw` is the parameter — already frozen by the shared parser.
    // No second freeze needed here (mirror of ArisSkillsLoader post-Slice-2).
    raw,
  };
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

const AGENT_FILENAME = "AGENT.md";
const AGENTS_SUBDIR = path.join(".aris", "agents");

/**
 * Resolve the per-source agents root. Returns `null` when the source
 * is not configured (e.g. workspaceRoot undefined or userHome === null).
 */
function resolveAgentsRoot(
  opts: LoadAgentTemplatesOptions,
  source: AgentTemplateSource,
): string | null {
  if (source === "project") {
    return opts.workspaceRoot ? path.join(opts.workspaceRoot, AGENTS_SUBDIR) : null;
  }
  // user
  if (opts.userHome === null) return null;
  const home = opts.userHome ?? os.homedir();
  if (!home) return null;
  return path.join(home, AGENTS_SUBDIR);
}

/**
 * Enumerate `<root>/<name>/AGENT.md` candidate files, ignoring entries
 * that aren't directories. Returns absolute paths and any non-fatal
 * error encountered while reading the root. A missing root is not an
 * error — callers expect `[]` when templates haven't been set up.
 * Other errors (permission denied, I/O failure) are reported as a
 * single synthetic error on the root path so the overall loader
 * never rejects.
 */
async function enumerateAgentTemplateFiles(
  root: string,
  source: AgentTemplateSource,
): Promise<{ files: string[]; errors: AgentTemplateLoadError[] }> {
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
          message: `Failed to read agents root: ${describeError(err)}`,
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
    found.push(path.join(dir, AGENT_FILENAME));
  }
  return { files: found.toSorted(), errors: [] };
}

async function loadAgentTemplatesFromRoot(
  root: string,
  source: AgentTemplateSource,
): Promise<{ templates: AgentTemplate[]; errors: AgentTemplateLoadError[] }> {
  const enumeration = await enumerateAgentTemplateFiles(root, source);
  const files = enumeration.files;
  const templates: AgentTemplate[] = [];
  const errors: AgentTemplateLoadError[] = [...enumeration.errors];

  for (const filePath of files) {
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Directory without an AGENT.md — silently skip. Authors may
        // create the dir before the file, no need to nag.
        continue;
      }
      errors.push({
        path: filePath,
        source,
        message: `Failed to read AGENT.md: ${describeError(err)}`,
      });
      continue;
    }

    const parsed = parseAgentTemplateFile(content);
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
        message: "Agent template has no name (empty directory and no `name:` frontmatter field).",
      });
      continue;
    }
    templates.push({
      name,
      source,
      filePath,
      directory,
      frontmatter: parsed.frontmatter,
      body: parsed.body,
    });
  }
  return { templates, errors };
}

function describeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Discover and parse all agent templates across project and user roots,
 * then merge with the optional bundled set at the lowest precedence.
 *
 * Precedence: project > user > bundled. When a name appears in multiple
 * sources, the higher-precedence entry wins and lower ones are dropped
 * silently. Overriding is the intended pattern, not an error.
 *
 * Errors from individual files are aggregated into `errors` and never
 * thrown. The result is always usable: a single malformed AGENT.md
 * doesn't block the rest of the user's library.
 */
export async function loadAllAgentTemplates(
  opts: LoadAgentTemplatesOptions,
): Promise<LoadAgentTemplatesResult> {
  const projectRoot = resolveAgentsRoot(opts, "project");
  const userRoot = resolveAgentsRoot(opts, "user");

  const [project, user] = await Promise.all([
    projectRoot
      ? loadAgentTemplatesFromRoot(projectRoot, "project")
      : Promise.resolve({ templates: [], errors: [] }),
    userRoot
      ? loadAgentTemplatesFromRoot(userRoot, "user")
      : Promise.resolve({ templates: [], errors: [] }),
  ]);

  // Precedence ladder (highest → lowest): project > user > bundled.
  // Build the result by walking from highest down, dropping entries
  // whose name has already been claimed. Bundled lives at the bottom
  // so a host can ship a baseline that users freely override.
  const claimed = new Set<string>();
  const merged: AgentTemplate[] = [];
  for (const template of project.templates) {
    claimed.add(template.name);
    merged.push(template);
  }
  for (const template of user.templates) {
    if (claimed.has(template.name)) continue;
    claimed.add(template.name);
    merged.push(template);
  }
  for (const template of opts.bundledTemplates ?? []) {
    if (claimed.has(template.name)) continue;
    claimed.add(template.name);
    merged.push(template);
  }

  return {
    templates: Object.freeze(merged) as ReadonlyArray<AgentTemplate>,
    errors: Object.freeze([
      ...project.errors,
      ...user.errors,
    ]) as ReadonlyArray<AgentTemplateLoadError>,
  };
}
