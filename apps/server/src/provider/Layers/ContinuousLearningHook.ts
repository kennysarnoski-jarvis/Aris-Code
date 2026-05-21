/**
 * ContinuousLearningHook — native TS port of ECC's continuous-learning-v2
 * `observe.sh` shell observer.
 *
 * The ECC version ran as a Claude-Code PreToolUse/PostToolUse shell
 * hook, parsing stdin JSON with Python, then appending observations to
 * `~/.claude/homunculus/projects/<project>/observations.jsonl`. We're
 * porting the same observation format to Aris's native HookBus so
 * patterns get captured without spawning subprocesses.
 *
 * Two hook subscribers:
 *
 *   1. **PostToolUse** — every tool call the model makes lands here.
 *      We write a JSONL line capturing tool name, args, result,
 *      session id, project id, and timestamp. Secrets get scrubbed
 *      before write. Input + output are truncated to 5000 chars to
 *      keep the log bounded.
 *
 *   2. **Stop** — fires at the end of every assistant turn. We write
 *      a `stop` marker so a downstream analyzer can group observations
 *      by turn. The marker carries the turn index.
 *
 * Storage layout:
 *
 *   ~/.aris/projects/<projectKey>/observations.jsonl     ← active log
 *   ~/.aris/projects/<projectKey>/observations.archive/  ← rotated files
 *
 * `projectKey` is computed via `projectKeyFromCwd` so this lives next
 * to the rolling-window archive + scratchpad + todos for the same
 * project. The 10 MB rotation matches ECC's threshold.
 *
 * Phase 4 (NOT this slice): a separate background analyzer reads the
 * accumulated JSONL, clusters observations, and embeds the resulting
 * "instincts" into the `arisllm` KG so the GAT reranks them alongside
 * the existing 350k concepts. This module just captures; the analyzer
 * lives in a follow-up.
 *
 * Failure mode:
 *   Observation write failures NEVER bubble. The HookBus catches them
 *   per the documented PostToolUse contract, and we additionally swallow
 *   any I/O errors at the handler level so a disk-full or permission
 *   problem can't degrade model behavior. The model is the user-facing
 *   surface; observation is a side effect.
 *
 * @module ContinuousLearningHook
 */

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { HookSpec, PostToolUseContext, StopContext } from "./HookTypes.ts";
import { projectKeyFromCwd } from "./RollingWindowMemory.ts";

const POST_HOOK_NAME = "continuous-learning-observe";
const STOP_HOOK_NAME = "continuous-learning-stop";
const HOOK_PRIORITY = 200;

const DEFAULT_MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TRUNCATE_LIMIT = 5000;

/**
 * Match common secret patterns: `<key>(separator)[<scheme>] <value>`.
 *   key: api_key | apikey | token | secret | password | authorization |
 *        credentials | auth (case-insensitive)
 *   separator: any of `" ' \s : =` (one or more)
 *   scheme: optional `Bearer ` / `Basic ` etc. (alpha + whitespace)
 *   value: 8+ chars of alnum + `_` `-` `/` `.` `+` `=`
 *
 * Capture-group layout matches the Python regex in `observe.sh` so the
 * scrub function is bit-identical: replace group 4 with `[REDACTED]`,
 * keep the prefix/separator/scheme intact.
 */
const SECRET_RE =
  /(api[_-]?key|token|secret|password|authorization|credentials?|auth)(["'\s:=]+)([A-Za-z]+\s+)?([A-Za-z0-9_\-/.+=]{8,})/gi;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Scrub a string for common secret patterns. */
export function scrubSecrets(value: string): string {
  return value.replace(
    SECRET_RE,
    (_match, key: string, sep: string, scheme: string | undefined, _val: string) =>
      `${key}${sep}${scheme ?? ""}[REDACTED]`,
  );
}

/**
 * Convert any value to a string suitable for the observation log, with
 * a length cap. Objects are JSON-stringified; non-stringifiable values
 * fall back to `String(value)`. Then we cap at `limit` chars.
 */
export function stringifyAndTruncate(value: unknown, limit = DEFAULT_TRUNCATE_LIMIT): string {
  if (value === undefined) return "";
  if (typeof value === "string") return value.slice(0, limit);
  try {
    return JSON.stringify(value).slice(0, limit);
  } catch {
    return String(value).slice(0, limit);
  }
}

/** Build the per-project observations path under `~/.aris/projects/`. */
export function defaultObservationsPath(cwd: string | undefined): string {
  const key = projectKeyFromCwd(cwd ?? "");
  return path.join(os.homedir(), ".aris", "projects", key, "observations.jsonl");
}

/**
 * Rotate the active observations file when it exceeds `maxBytes`. The
 * active file is renamed into a sibling `observations.archive/`
 * directory with a timestamp suffix. Best-effort: ENOENT (no file yet)
 * is silently ignored.
 */
async function rotateIfTooLarge(filePath: string, maxBytes: number): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (stat.size < maxBytes) return;

  const archiveDir = path.join(path.dirname(filePath), "observations.archive");
  await fs.mkdir(archiveDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const archivePath = path.join(archiveDir, `observations-${ts}.jsonl`);
  await fs.rename(filePath, archivePath);
}

/**
 * Append a single observation line. Creates the parent directory on
 * demand and rotates the file first if it's over threshold. Failures
 * are swallowed by the caller; this function rejects so unit tests
 * can assert behavior.
 */
async function appendObservationLine(
  filePath: string,
  payload: object,
  maxBytes: number,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await rotateIfTooLarge(filePath, maxBytes);
  await fs.appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf-8");
}

// ---------------------------------------------------------------------------
// Public configuration
// ---------------------------------------------------------------------------

export interface ContinuousLearningHookOptions {
  /**
   * Override the path the hook writes to. Useful for tests (point to
   * a tmpdir) and for embedding under custom user-data layouts.
   * Defaults to `~/.aris/projects/<projectKey>/observations.jsonl`.
   */
  readonly observationsPath?: (cwd: string | undefined) => string;
  /**
   * Override the byte threshold above which the active file is rotated
   * into `observations.archive/`. Defaults to 10 MB.
   */
  readonly maxFileSizeBytes?: number;
  /**
   * Override the per-field truncation cap. Defaults to 5000 chars,
   * matching observe.sh's behavior. Tests use a smaller cap for
   * assertion convenience.
   */
  readonly truncateLimit?: number;
}

// ---------------------------------------------------------------------------
// PostToolUse hook — captures tool-call observations
// ---------------------------------------------------------------------------

/**
 * Build the PostToolUse observation hook. Captures every model tool
 * call to project-scoped JSONL. Errors during write are swallowed so
 * the model never sees an observation failure.
 *
 * Priority 200 puts this AFTER any default-priority (100) post-tool
 * handler so app-level reactions to tool results (formatters,
 * notifications, etc.) get to run before observation logging.
 */
export function makeContinuousLearningPostToolUseHook(
  opts: ContinuousLearningHookOptions = {},
): Extract<HookSpec, { event: "PostToolUse" }> {
  const resolvePath = opts.observationsPath ?? defaultObservationsPath;
  const maxBytes = opts.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
  const truncateLimit = opts.truncateLimit ?? DEFAULT_TRUNCATE_LIMIT;

  return {
    event: "PostToolUse",
    name: POST_HOOK_NAME,
    priority: HOOK_PRIORITY,
    handler: async (ctx: PostToolUseContext): Promise<void> => {
      const filePath = resolvePath(ctx.cwd);
      const inputStr = stringifyAndTruncate(ctx.args, truncateLimit);
      const outputStr = stringifyAndTruncate(ctx.result, truncateLimit);

      const observation = {
        timestamp: new Date().toISOString(),
        event: "tool_complete" as const,
        tool: ctx.toolName,
        session: ctx.threadId,
        project_id: projectKeyFromCwd(ctx.cwd ?? ""),
        input: inputStr.length > 0 ? scrubSecrets(inputStr) : null,
        output: outputStr.length > 0 ? scrubSecrets(outputStr) : null,
      };

      try {
        await appendObservationLine(filePath, observation, maxBytes);
      } catch {
        // Swallow — observation failure never blocks the model. The
        // HookBus error handler would also catch this, but we belt-
        // and-suspenders it because some I/O errors (EACCES, EROFS,
        // ENOSPC) are predictable and shouldn't even surface in
        // server logs as "hook threw" noise.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Stop hook — turn-boundary marker
// ---------------------------------------------------------------------------

/**
 * Build the Stop hook that writes a turn-boundary marker to the same
 * observations log. Lets a downstream analyzer group observations by
 * assistant turn without timing heuristics.
 */
export function makeContinuousLearningStopHook(
  opts: ContinuousLearningHookOptions = {},
): Extract<HookSpec, { event: "Stop" }> {
  const resolvePath = opts.observationsPath ?? defaultObservationsPath;
  const maxBytes = opts.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;

  return {
    event: "Stop",
    name: STOP_HOOK_NAME,
    priority: HOOK_PRIORITY,
    handler: async (ctx: StopContext): Promise<void> => {
      const filePath = resolvePath(ctx.cwd);
      const marker = {
        timestamp: new Date().toISOString(),
        event: "stop" as const,
        session: ctx.threadId,
        project_id: projectKeyFromCwd(ctx.cwd ?? ""),
        turn_index: ctx.turnIndex,
      };

      try {
        await appendObservationLine(filePath, marker, maxBytes);
      } catch {
        // Same swallow policy as PostToolUse.
      }
    },
  };
}
