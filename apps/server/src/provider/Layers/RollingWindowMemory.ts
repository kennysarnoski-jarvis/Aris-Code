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

// ---------------------------------------------------------------------------
// Slice L / M3-2 — RollingWindowConfig (2026-05-18)
//
// Mirrors the FactsConfig pattern from Slice G. Pre-Slice-L every IO
// function reached for `homedir()` implicitly at call time, so any test
// run that didn't swap `process.env.HOME` would write into the real
// `~/.aris/projects/<key>/sessions/<thread>/active.jsonl` — same class
// of bug that polluted facts.jsonl back in March.
//
// The fix: `RollingWindowConfig` is a value object carrying the
// resolved `arisHomeDir`. `makeRollingWindowConfig()` is the ONE
// place `homedir()` is called — at the composition root. Every IO
// function takes `config` explicitly. Tests build their own pointed
// at a temp dir; no HOME swapping needed.
// ---------------------------------------------------------------------------

/** Resolved filesystem paths for the rolling-window store. */
export interface RollingWindowConfig {
  readonly arisHomeDir: string;
}

/**
 * Construct a `RollingWindowConfig` from a home directory. This is
 * the ONLY call site for `homedir()` in the rolling-window subsystem
 * — every IO function below receives an explicit config instead of
 * reaching for HOME implicitly.
 *
 * `homeOverride` exists for tests; production callers omit it.
 */
export function makeRollingWindowConfig(homeOverride?: string): RollingWindowConfig {
  const home = homeOverride ?? homedir();
  return {
    arisHomeDir: join(home, ARIS_HOME_DIR),
  };
}

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
 * Image-attachment metadata as persisted to active.jsonl alongside a
 * user message. The actual file bytes live on disk in `attachmentsDir`
 * (resolvable via `resolveAttachmentPath` / `resolveAttachmentPathById`),
 * so the persisted record only needs the lookup key + display fields.
 *
 * Mirrors `ChatImageAttachment` from `@t3tools/contracts/orchestration`,
 * deliberately duplicated here to avoid a runtime dependency from this
 * pure-Node module on the Effect/Schema-backed contracts package — the
 * shape is stable and any future drift gets caught by the zero-arg
 * `attachmentRelativePath` call site in `resolveAttachmentPath` if a
 * required field is dropped.
 */
export interface PersistedAttachment {
  readonly type: "image";
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
}

/**
 * One turn-message component as persisted to active.jsonl. Mirrors the
 * shape OpenAI / DeepSeek expect on the wire (`role`, `content`) so
 * that future replay (RW-2) can round-trip without translation.
 *
 * `attachments` was added 2026-05-13 so user messages with image uploads
 * survive thread reload — without it, the UI chip vanishes after the
 * optimistic-message stage because the archive hydration (RW-2.5) re-
 * derives `serverMessages` from this file. Optional (and absent on
 * every record written before that date) — assistant messages and pre-
 * vision user messages have no attachments to record.
 */
export interface PersistedMessage {
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly timestamp: string;
  readonly messageId: string;
  readonly turnId: string;
  readonly attachments?: ReadonlyArray<PersistedAttachment>;
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
 * Slice H.3 / H3-3 fix (2026-05-16) — `threadId` is a branded
 * `TrimmedNonEmptyString` at the contract layer with NO path-safety
 * validation. Pre-Slice-H, the WS RPC `readArchive` handler accepted a
 * `threadId` like `"../../../../../etc"` and `path.join` happily
 * normalized the traversal — the resulting path escaped the
 * `sessions/` directory and let an attacker read any file the server
 * process could access.
 *
 * The fix is a single point of enforcement: every function that uses
 * `threadId` to build an on-disk path routes through `assertSafeThreadId`
 * first. A `threadId` must be a non-empty slug of letters / digits /
 * dash / underscore — no path separators, no traversal sequences, no
 * NUL bytes. The canonical thread-id shape (UUIDs or `thread_<uuid>`)
 * satisfies this; nothing legitimate ever needs `/` or `..` in a
 * threadId.
 *
 * Throws synchronously rather than returning a result so callers
 * (which all currently treat the path build as infallible) fail loudly
 * if a bad id ever reaches them. The Effect-side callers wrap this in
 * `Effect.tryPromise` already, so the throw becomes a tagged error.
 */
const THREAD_ID_SAFE_RE = /^[A-Za-z0-9_-]+$/;
function assertSafeThreadId(threadId: string): void {
  if (threadId.length === 0) {
    throw new Error("RollingWindowMemory: threadId is empty");
  }
  if (threadId.length > 256) {
    throw new Error("RollingWindowMemory: threadId exceeds 256 chars");
  }
  if (!THREAD_ID_SAFE_RE.test(threadId)) {
    throw new Error(
      `RollingWindowMemory: threadId contains unsafe characters (must match [A-Za-z0-9_-]+)`,
    );
  }
}

/**
 * Full path to the per-thread archive directory. No filesystem touch —
 * pure path math. Use `ensureThreadArchiveDir` to mkdir -p.
 *
 * Slice H.3 / H3-3 — guards the `threadId` segment against path
 * traversal; see `assertSafeThreadId` above.
 */
export function getThreadArchiveDir(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): string {
  assertSafeThreadId(threadId);
  return join(
    config.arisHomeDir,
    PROJECTS_SUBDIR,
    projectKeyFromCwd(cwd),
    SESSIONS_SUBDIR,
    threadId,
  );
}

/** Path to the active (in-progress) rolling window file for this thread. */
export function getActiveWindowPath(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): string {
  return join(getThreadArchiveDir(config, cwd, threadId), ACTIVE_WINDOW_FILENAME);
}

/**
 * Idempotent mkdir -p on the per-thread archive directory. Safe to call
 * before every append; fs.mkdir with recursive:true no-ops if the dir
 * already exists.
 */
export async function ensureThreadArchiveDir(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): Promise<void> {
  await fs.mkdir(getThreadArchiveDir(config, cwd, threadId), { recursive: true });
}

/**
 * Append one message to the thread's active.jsonl. Atomic at the
 * line level — fs.appendFile uses O_APPEND so concurrent writes don't
 * interleave bytes within a single line. We also fsync via the {flush:
 * true} flag so a crash mid-conversation loses at most the last
 * unflushed message rather than corrupting the whole file.
 */
export async function appendToActiveWindow(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
  message: PersistedMessage,
): Promise<void> {
  await ensureThreadArchiveDir(config, cwd, threadId);
  const line = JSON.stringify(message) + "\n";
  await fs.appendFile(getActiveWindowPath(config, cwd, threadId), line, {
    encoding: "utf8",
    flush: true,
  });
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
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): Promise<ReadonlyArray<PersistedMessage>> {
  const path = getActiveWindowPath(config, cwd, threadId);
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
        // Defensive shape check on attachments. Records written before
        // 2026-05-13 won't have it; that's fine — omit the field.
        // Records with malformed attachments get their attachments
        // field stripped rather than the whole record dropped (the
        // text content is still useful for conversation continuity).
        const sanitizedAttachments = sanitizePersistedAttachments(parsed.attachments);
        const base = {
          role: parsed.role,
          content: parsed.content,
          timestamp: parsed.timestamp,
          messageId: parsed.messageId,
          turnId: parsed.turnId,
        } satisfies Omit<PersistedMessage, "attachments">;
        out.push(
          sanitizedAttachments !== undefined
            ? { ...base, attachments: sanitizedAttachments }
            : base,
        );
      }
    } catch {
      console.warn(`[RollingWindowMemory] dropped corrupt line in ${path}: ${line.slice(0, 80)}…`);
    }
  }
  return out;
}

/**
 * Strict per-field shape check for one PersistedAttachment. Returns the
 * sanitized record if every field is present and the right primitive
 * type, otherwise `null` (which the caller filters out). Keeps the
 * `readActiveWindow` permissive-but-typed contract — one bad attachment
 * is dropped, the rest survive.
 */
function sanitizePersistedAttachment(candidate: unknown): PersistedAttachment | null {
  if (!candidate || typeof candidate !== "object") return null;
  const obj = candidate as Record<string, unknown>;
  if (
    obj.type === "image" &&
    typeof obj.id === "string" &&
    obj.id.length > 0 &&
    typeof obj.name === "string" &&
    typeof obj.mimeType === "string" &&
    typeof obj.sizeBytes === "number" &&
    Number.isFinite(obj.sizeBytes) &&
    obj.sizeBytes >= 0
  ) {
    return {
      type: "image",
      id: obj.id,
      name: obj.name,
      mimeType: obj.mimeType,
      sizeBytes: obj.sizeBytes,
    };
  }
  return null;
}

/**
 * Returns `undefined` when the input is absent or yields zero valid
 * attachments after sanitization, otherwise the cleaned readonly array.
 * Distinguishing "absent" from "present-but-empty" matters here because
 * old records have no field at all and we don't want to falsely emit
 * an empty array (the absence is the signal the record predates
 * vision).
 */
function sanitizePersistedAttachments(
  attachments: unknown,
): ReadonlyArray<PersistedAttachment> | undefined {
  if (attachments === undefined || attachments === null) return undefined;
  if (!Array.isArray(attachments)) return undefined;
  const clean: PersistedAttachment[] = [];
  for (const candidate of attachments) {
    const sanitized = sanitizePersistedAttachment(candidate);
    if (sanitized) clean.push(sanitized);
  }
  return clean.length > 0 ? clean : undefined;
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
export async function estimateActiveWindowTokens(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): Promise<number> {
  const path = getActiveWindowPath(config, cwd, threadId);
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
async function nextWindowIndex(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): Promise<number> {
  const dir = getThreadArchiveDir(config, cwd, threadId);
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
export function getArchivedWindowPath(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
  windowIndex: number,
): string {
  const padded = String(windowIndex).padStart(3, "0");
  return join(
    getThreadArchiveDir(config, cwd, threadId),
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
/**
 * Slice Y / Cross-thread V2 — minimum size of `active.jsonl` before
 * a thread-close summary is worth generating. Threads under this
 * threshold are typically one-shot exchanges ("hi" / "what's the
 * time?" / single-question lookups) that don't carry forward useful
 * project context. Generating a summary for them burns a DeepSeek
 * Pro call to produce noise that pollutes the next thread's
 * cross-thread briefing.
 *
 * 2048 bytes ≈ 500 tokens of conversation — roughly the smallest
 * threshold below which a rollup wouldn't have anything meaningful
 * to capture. Substantive but short threads (a quick code review
 * exchange, a focused bug investigation) clear this easily.
 */
export const THREAD_CLOSE_MIN_ACTIVE_BYTES = 2048;

/**
 * Result of a thread-close archive attempt. Same shape pattern as
 * `RolloverResult`: `archived: false` when the thread had nothing
 * meaningful to summarize (no active.jsonl, or below the size
 * threshold); `archived: true` when we performed the rename and the
 * caller should fire `generateRolloverSummaryBackground` against
 * the returned `archivedPath`.
 */
export type ThreadCloseArchiveResult =
  | {
      readonly archived: false;
      readonly reason: "no-active-file" | "below-threshold";
      readonly currentBytes: number;
    }
  | {
      readonly archived: true;
      readonly windowIndex: number;
      readonly archivedPath: string;
      readonly archivedBytes: number;
    };

/**
 * Slice Y / Cross-thread V2 — finalize a thread's `active.jsonl`
 * into a window archive when the thread is being closed. Used by
 * `DeepSeekAdapter.stopSessionInternal` to close the cross-thread
 * memory gap that Slice X (`CrossThreadMemory.ts`) left open:
 * threads that never rolled over have no `window_NNN.summary.md`
 * file, so a fresh thread's cross-thread scan can't see them.
 *
 * This function reuses the existing rollover machinery — rename
 * `active.jsonl` to the next `window_NNN.jsonl`, then return the
 * info needed for the caller to fire `generateRolloverSummaryBackground`.
 * No new file format; no parallel code path; future scans (Slice X)
 * find the resulting summary identically to one produced by
 * `tryRollover`.
 *
 * Threshold rationale: see `THREAD_CLOSE_MIN_ACTIVE_BYTES`. Threads
 * under the threshold get `archived: false` so the adapter skips the
 * Pro call entirely. Empty / missing `active.jsonl` is the no-op
 * case (`reason: "no-active-file"`).
 *
 * Atomicity + idempotency match `tryRollover` — fs.rename is atomic
 * on same-filesystem, and `archived: false` returns don't mutate
 * disk.
 */
export async function archiveActiveWindowOnClose(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): Promise<ThreadCloseArchiveResult> {
  const activePath = getActiveWindowPath(config, cwd, threadId);
  let currentBytes = 0;
  try {
    const stat = await fs.stat(activePath);
    currentBytes = stat.size;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { archived: false, reason: "no-active-file", currentBytes: 0 };
    }
    throw err;
  }

  if (currentBytes < THREAD_CLOSE_MIN_ACTIVE_BYTES) {
    return { archived: false, reason: "below-threshold", currentBytes };
  }

  await ensureThreadArchiveDir(config, cwd, threadId);
  const windowIndex = await nextWindowIndex(config, cwd, threadId);
  const archivedPath = getArchivedWindowPath(config, cwd, threadId, windowIndex);

  await fs.rename(activePath, archivedPath);
  console.error(
    `[RollingWindowMemory] THREAD-CLOSE ARCHIVE threadId=${threadId} ` +
      `bytes=${currentBytes} archived=${archivedPath}`,
  );
  return {
    archived: true,
    windowIndex,
    archivedPath,
    archivedBytes: currentBytes,
  };
}

export async function tryRollover(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): Promise<RolloverResult> {
  const threshold = getRolloverThreshold();
  const currentTokens = await estimateActiveWindowTokens(config, cwd, threadId);
  if (currentTokens < threshold) {
    return { rolledOver: false, currentTokens, threshold };
  }

  await ensureThreadArchiveDir(config, cwd, threadId);
  const windowIndex = await nextWindowIndex(config, cwd, threadId);
  const activePath = getActiveWindowPath(config, cwd, threadId);
  const archivedPath = getArchivedWindowPath(config, cwd, threadId, windowIndex);

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
