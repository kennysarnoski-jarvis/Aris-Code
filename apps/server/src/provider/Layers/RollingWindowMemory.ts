/**
 * RollingWindowMemory — persistent per-thread conversation memory backed
 * by .jsonl archives on disk.
 *
 * Slice RW-1: Foundation. Provides the filesystem layer and append/read
 * primitives. No rollover logic, no summary generation, no retrieval
 * tools yet — those land in RW-3 through RW-6.
 *
 * Layout (mirrors Anthropic's `~/.claude/projects/<git-root>/sessions/`
 * pattern, see `~/Projects/claude-code/spec/06_services_context_state.md`):
 *
 *   ~/.aris/projects/<project-key>/sessions/<thread-id>/
 *     active.jsonl              ← current rolling window, in-progress
 *     window_001.jsonl          ← archived window (post-rollover)
 *     window_001.summary.md     ← rollup summary (post-RW-4)
 *     window_002.jsonl
 *     window_002.summary.md
 *
 * Project key: a sanitized form of the workspace cwd. Per the design
 * memo, conversation history is the user's data, not the codebase's,
 * and lives in user-home so it survives `rm -rf` on the project,
 * follows multiple worktrees, and stays out of git.
 *
 * Format (V1): one JSON line per turn-message-pair component.
 *   { "role": "user", "content": "...", "timestamp": "...", "messageId": "...", "turnId": "..." }
 *   { "role": "assistant", "content": "...", "timestamp": "...", "messageId": "...", "turnId": "..." }
 *
 * Tool calls and tool results are intentionally NOT persisted in V1.
 * They're intermediate SDK-loop state; their effects are captured by
 * the final assistant text. Multi-turn replay only needs role/content.
 * If we later want richer summaries that mention specific tool calls,
 * we revisit (likely by tapping additional aris.tool.* events).
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join, isAbsolute, sep } from "node:path";

import { Data } from "effect";

const ARIS_HOME_DIR = ".aris";
const PROJECTS_SUBDIR = "projects";
const SESSIONS_SUBDIR = "sessions";
const ACTIVE_WINDOW_FILENAME = "active.jsonl";

/**
 * Default token-budget threshold at which the active rolling window
 * gets frozen and a new one starts. 920K leaves ~80K headroom inside
 * DeepSeek V4-Pro's 1M context for the next turn (model reasoning +
 * tool calls + tool results + visible response + summary generation
 * ride in that headroom).
 *
 * Override via env: `ARIS_RW_ROLLOVER_TOKEN_THRESHOLD` — useful for
 * local dev where you want to exercise rollover without sending 920K
 * worth of conversation. e.g. `ARIS_RW_ROLLOVER_TOKEN_THRESHOLD=5000`
 * triggers rollover after a few short turns.
 */
const DEFAULT_ROLLOVER_THRESHOLD_TOKENS = 920_000;
const WINDOW_FILENAME_PREFIX = "window_";
const WINDOW_FILENAME_SUFFIX = ".jsonl";

/**
 * Tagged error for any rolling-window I/O failure (read, append, mkdir).
 * Lives here so callers in DeepSeekAdapter can construct it from inside
 * `Effect.tryPromise.catch` without violating Effect v4's strict
 * "no untagged errors" rule. The original cause is preserved on
 * `cause` for logging.
 */
export class RollingWindowIOError extends Data.TaggedError("RollingWindowIOError")<{
  readonly operation: "read" | "append" | "mkdir";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Helper that wraps an unknown thrown value into a `RollingWindowIOError`
 * for use as the `catch:` callback of `Effect.tryPromise`. Effect v4
 * lints against returning the global `Error` directly (loses tag-based
 * narrowing) — this gives every caller a consistent, properly tagged
 * error shape.
 */
export function toRollingWindowIOError(operation: "read" | "append" | "mkdir") {
  return (cause: unknown): RollingWindowIOError =>
    new RollingWindowIOError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
}

/**
 * One turn-message component as persisted to active.jsonl. Mirrors the
 * shape OpenAI / DeepSeek expect on the wire (`role`, `content`) so
 * that future replay (RW-2) can round-trip without translation.
 */
export interface PersistedMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: string;
  readonly messageId: string;
  readonly turnId: string;
}

/**
 * Convert a workspace cwd into a stable, filesystem-safe key.
 *
 * - Strips the leading slash so the key isn't an absolute path again.
 * - Replaces path separators with `__` (visually distinct, no escape
 *   collisions with other shell metachars).
 * - Lowercases so two users with different case sensitivity settings
 *   don't end up with two separate archives for the same project.
 *
 * Examples:
 *   /Users/kenny/Projects/t3code → users__kenny__projects__t3code
 *   /home/dev/work/api          → home__dev__work__api
 */
export function projectKeyFromCwd(cwd: string): string {
  if (!cwd) return "_unknown";
  const normalized = isAbsolute(cwd) ? cwd.slice(1) : cwd;
  return normalized
    .split(sep)
    .filter((seg) => seg.length > 0)
    .join("__")
    .toLowerCase();
}

/**
 * Full path to the per-thread archive directory. No filesystem touch —
 * pure path math. Use `ensureThreadArchiveDir` to mkdir -p.
 */
export function getThreadArchiveDir(cwd: string, threadId: string): string {
  return join(
    homedir(),
    ARIS_HOME_DIR,
    PROJECTS_SUBDIR,
    projectKeyFromCwd(cwd),
    SESSIONS_SUBDIR,
    threadId,
  );
}

/** Path to the active (in-progress) rolling window file for this thread. */
export function getActiveWindowPath(cwd: string, threadId: string): string {
  return join(getThreadArchiveDir(cwd, threadId), ACTIVE_WINDOW_FILENAME);
}

/**
 * Idempotent mkdir -p on the per-thread archive directory. Safe to call
 * before every append; fs.mkdir with recursive:true no-ops if the dir
 * already exists.
 */
export async function ensureThreadArchiveDir(cwd: string, threadId: string): Promise<void> {
  await fs.mkdir(getThreadArchiveDir(cwd, threadId), { recursive: true });
}

/**
 * Append one message to the thread's active.jsonl. Atomic at the
 * line level — fs.appendFile uses O_APPEND so concurrent writes don't
 * interleave bytes within a single line. We also fsync via the {flush:
 * true} flag so a crash mid-conversation loses at most the last
 * unflushed message rather than corrupting the whole file.
 */
export async function appendToActiveWindow(
  cwd: string,
  threadId: string,
  message: PersistedMessage,
): Promise<void> {
  await ensureThreadArchiveDir(cwd, threadId);
  const line = JSON.stringify(message) + "\n";
  await fs.appendFile(getActiveWindowPath(cwd, threadId), line, { encoding: "utf8", flush: true });
}

/**
 * Read the active window back as a parsed message array. Returns []
 * if the file doesn't exist yet (first turn of a new thread).
 *
 * Used by RW-2 to seed the next turn's request with prior messages.
 * Lines that fail to parse are dropped with a console warning rather
 * than throwing — a single corrupted line shouldn't break the whole
 * thread's history. (Corruption is unlikely given append-only + fsync,
 * but defensive parsing costs nothing.)
 */
export async function readActiveWindow(
  cwd: string,
  threadId: string,
): Promise<ReadonlyArray<PersistedMessage>> {
  const path = getActiveWindowPath(cwd, threadId);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const out: PersistedMessage[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    try {
      const parsed = JSON.parse(line) as PersistedMessage;
      if (
        (parsed.role === "user" || parsed.role === "assistant") &&
        typeof parsed.content === "string" &&
        typeof parsed.timestamp === "string" &&
        typeof parsed.messageId === "string" &&
        typeof parsed.turnId === "string"
      ) {
        out.push(parsed);
      }
    } catch {
      console.warn(`[RollingWindowMemory] dropped corrupt line in ${path}: ${line.slice(0, 80)}…`);
    }
  }
  return out;
}

/**
 * Cheap token-count estimate for the active window. Used by RW-3 to
 * decide whether to roll over.
 *
 * Uses byte length / 4 as a rough heuristic — same approximation
 * Anthropic's `roughTokenCountEstimation` uses (~4 chars per token
 * for English/code). Returns 0 if the file doesn't exist.
 *
 * Why this approximation is fine: the rollover threshold is 920K
 * with 80K headroom for the next turn. Even a 20% estimation error
 * leaves comfortable margin before we'd actually overflow the model
 * context. We don't need a real tokenizer here.
 */
export async function estimateActiveWindowTokens(cwd: string, threadId: string): Promise<number> {
  const path = getActiveWindowPath(cwd, threadId);
  try {
    const stat = await fs.stat(path);
    return Math.ceil(stat.size / 4);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw err;
  }
}

// ── Rollover (RW-3) ─────────────────────────────────────────────────

/**
 * Resolve the active rollover threshold in tokens. Reads the
 * `ARIS_RW_ROLLOVER_TOKEN_THRESHOLD` env var if set; falls back to
 * `DEFAULT_ROLLOVER_THRESHOLD_TOKENS` (920K). Invalid values silently
 * fall back to the default — we never want a typo to disable
 * rollover entirely.
 */
export function getRolloverThreshold(): number {
  const raw = process.env["ARIS_RW_ROLLOVER_TOKEN_THRESHOLD"]?.trim();
  if (raw && raw.length > 0) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_ROLLOVER_THRESHOLD_TOKENS;
}

/**
 * Find the next available `window_NNN.jsonl` slot in the thread's
 * archive directory by scanning existing window files and taking
 * `max + 1`. Returns 1 when no archived windows exist yet.
 *
 * Padding: 3 digits for sortability up to window_999. We don't expect
 * to hit that in practice (would imply ~920M tokens of conversation
 * in a single thread), but the format is fixed-width so directory
 * listings stay alphabetically ordered.
 */
async function nextWindowIndex(cwd: string, threadId: string): Promise<number> {
  const dir = getThreadArchiveDir(cwd, threadId);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return 1;
    }
    throw err;
  }
  let maxIndex = 0;
  for (const name of entries) {
    if (!name.startsWith(WINDOW_FILENAME_PREFIX)) continue;
    if (!name.endsWith(WINDOW_FILENAME_SUFFIX)) continue;
    const middle = name.slice(WINDOW_FILENAME_PREFIX.length, -WINDOW_FILENAME_SUFFIX.length);
    const n = Number.parseInt(middle, 10);
    if (Number.isFinite(n) && n > maxIndex) {
      maxIndex = n;
    }
  }
  return maxIndex + 1;
}

/** Path to a specific archived window file. Pure path math. */
export function getArchivedWindowPath(cwd: string, threadId: string, windowIndex: number): string {
  const padded = String(windowIndex).padStart(3, "0");
  return join(
    getThreadArchiveDir(cwd, threadId),
    `${WINDOW_FILENAME_PREFIX}${padded}${WINDOW_FILENAME_SUFFIX}`,
  );
}

/**
 * Result of a rollover attempt. `rolledOver: false` when the active
 * window was below threshold (the common case — fires on every turn
 * boundary). `rolledOver: true` when we actually performed the
 * rename, with the new archived window's index returned for
 * downstream summary generation (RW-4).
 */
export type RolloverResult =
  | { readonly rolledOver: false; readonly currentTokens: number; readonly threshold: number }
  | {
      readonly rolledOver: true;
      readonly windowIndex: number;
      readonly archivedPath: string;
      readonly tokensAtRollover: number;
      readonly threshold: number;
    };

/**
 * Check whether `active.jsonl` has crossed the rollover threshold,
 * and if so atomically rename it to `window_NNN.jsonl`. Returns the
 * result either way so the caller can branch on whether rollover
 * happened (e.g. to kick off summary generation in RW-4).
 *
 * Atomicity: `fs.rename` is atomic within a single filesystem on
 * macOS/Linux, so we either get the renamed file OR active.jsonl
 * stays in place — never both, never neither. After rename, the next
 * `appendToActiveWindow` call will see no active.jsonl and create a
 * fresh empty one.
 *
 * Idempotency: calling this on an empty/missing active.jsonl is a
 * no-op (returns `rolledOver: false` with currentTokens=0). Safe to
 * call before every turn.
 *
 * Thread safety: assumes single-process access per thread (matches
 * the rest of the rolling-window module's assumptions). Concurrent
 * calls from multiple processes could collide on the rename.
 */
export async function tryRollover(cwd: string, threadId: string): Promise<RolloverResult> {
  const threshold = getRolloverThreshold();
  const currentTokens = await estimateActiveWindowTokens(cwd, threadId);
  if (currentTokens < threshold) {
    return { rolledOver: false, currentTokens, threshold };
  }

  await ensureThreadArchiveDir(cwd, threadId);
  const windowIndex = await nextWindowIndex(cwd, threadId);
  const activePath = getActiveWindowPath(cwd, threadId);
  const archivedPath = getArchivedWindowPath(cwd, threadId, windowIndex);

  await fs.rename(activePath, archivedPath);
  console.error(
    `[RollingWindowMemory] ROLLOVER threadId=${threadId} ` +
      `tokens=${currentTokens} threshold=${threshold} ` +
      `archived=${archivedPath}`,
  );
  return {
    rolledOver: true,
    windowIndex,
    archivedPath,
    tokensAtRollover: currentTokens,
    threshold,
  };
}
