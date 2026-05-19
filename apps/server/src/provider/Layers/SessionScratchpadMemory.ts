/**
 * SessionScratchpadMemory — coordinator-session-scoped jsonl shared
 * across all workers spawned within a single coordinator turn.
 *
 * Slice COORD-5: The "workers can't see each other's findings"
 * problem from Aris's critique. Solution: a turn-scoped append-only
 * scratchpad both the parent and any worker can read + append. When
 * the coordinator fans out 5 research workers, each worker can write
 * its findings as it discovers them, and subsequent workers can read
 * what prior workers found before deciding what to do.
 *
 * Distinct from the project scratchpad (MEM-1):
 *
 *   - MEM-1 scratchpad lives at `~/.aris/projects/<key>/scratchpad.jsonl`,
 *     scoped to the project, persists across threads, mutates over
 *     days/weeks. Set/append/clear semantics with the model owning
 *     the merge.
 *   - Session scratchpad lives at `~/.aris/projects/<key>/sessions/<thread>/coordinator-<turnId>.jsonl`,
 *     scoped to ONE coordinator turn, append-only (no clear), starts
 *     empty every turn. Each entry is timestamped + tagged with the
 *     writer (parent or worker description).
 *
 * Format — one JSON object per line, append-only:
 *
 *   { "id":"<uuid>", "ts":"<iso>", "writer":"parent" | "<workerDescription>",
 *     "content":"<freeform text the writer wants to share>" }
 *
 * Stale-file hygiene: each parent turn writes to a file with the
 * turn's id baked in, so concurrent turns don't collide. Files
 * accumulate over time; we don't auto-prune (cheap to leave them
 * around for debugging, low write rate).
 *
 * @module SessionScratchpadMemory
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Data } from "effect";

import { getThreadArchiveDir, type RollingWindowConfig } from "./RollingWindowMemory.ts";

const SESSION_SCRATCHPAD_FILE_PREFIX = "coordinator-";
const SESSION_SCRATCHPAD_FILE_SUFFIX = ".jsonl";

/**
 * Tagged error for any session-scratchpad I/O failure. Same pattern
 * as the other memory modules.
 */
export class SessionScratchpadIOError extends Data.TaggedError("SessionScratchpadIOError")<{
  readonly operation: "read" | "append" | "mkdir";
  readonly message: string;
  readonly cause?: unknown;
}> {}

export function toSessionScratchpadIOError(operation: "read" | "append" | "mkdir") {
  return (cause: unknown): SessionScratchpadIOError =>
    new SessionScratchpadIOError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
}

/**
 * One entry on the session scratchpad. Discriminated by writer
 * identity so the parent can tell which worker contributed what
 * (and so the reader can group by writer for legibility).
 */
export interface SessionScratchpadEntry {
  readonly id: string;
  readonly ts: string;
  readonly writer: string;
  readonly content: string;
}

/**
 * Path to the session scratchpad for a given parent turn. Pure path
 * math — no fs touch. Lives under the per-thread archive directory
 * (alongside active.jsonl + window_NNN files) so it shares the same
 * cleanup/backup semantics as conversation history.
 */
export function getSessionScratchpadPath(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
  parentTurnId: string,
): string {
  return join(
    getThreadArchiveDir(config, cwd, threadId),
    `${SESSION_SCRATCHPAD_FILE_PREFIX}${parentTurnId}${SESSION_SCRATCHPAD_FILE_SUFFIX}`,
  );
}

/**
 * Idempotent mkdir -p on the per-thread archive directory. Re-uses
 * the rolling-window directory which is already created by the
 * adapter on first append. Safe to call before every session-
 * scratchpad append.
 */
export async function ensureSessionScratchpadDir(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
): Promise<void> {
  await fs.mkdir(getThreadArchiveDir(config, cwd, threadId), { recursive: true });
}

/**
 * Parse one line into a `SessionScratchpadEntry`. Returns `null` for
 * lines that don't match the expected shape — caller drops nulls
 * with a console warning rather than throwing.
 */
function parseEntry(line: string): SessionScratchpadEntry | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["id"] !== "string") return null;
  if (typeof obj["ts"] !== "string") return null;
  if (typeof obj["writer"] !== "string") return null;
  if (typeof obj["content"] !== "string") return null;
  return {
    id: obj["id"],
    ts: obj["ts"],
    writer: obj["writer"],
    content: obj["content"],
  };
}

/**
 * Read all entries from the session scratchpad. Returns `[]` if the
 * file doesn't exist (no writes yet this turn).
 */
export async function readSessionScratchpadEntries(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
  parentTurnId: string,
): Promise<ReadonlyArray<SessionScratchpadEntry>> {
  const path = getSessionScratchpadPath(config, cwd, threadId, parentTurnId);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: SessionScratchpadEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const entry = parseEntry(line);
    if (entry === null) {
      console.warn(
        `[SessionScratchpadMemory] dropped corrupt line in ${path}: ${line.slice(0, 80)}…`,
      );
      continue;
    }
    out.push(entry);
  }
  return out;
}

/**
 * Append one entry to the session scratchpad. Atomic at the line
 * level (O_APPEND), fsynced via flush:true.
 */
export async function appendSessionScratchpadEntry(
  config: RollingWindowConfig,
  cwd: string,
  threadId: string,
  parentTurnId: string,
  entry: SessionScratchpadEntry,
): Promise<void> {
  await ensureSessionScratchpadDir(config, cwd, threadId);
  const line = JSON.stringify(entry) + "\n";
  await fs.appendFile(getSessionScratchpadPath(config, cwd, threadId, parentTurnId), line, {
    encoding: "utf8",
    flush: true,
  });
}

/**
 * Build a `SessionScratchpadEntry` with a fresh uuid + timestamp.
 * Tool layer uses this so it doesn't have to import crypto + clock
 * separately.
 */
export function newSessionScratchpadEntry(input: {
  readonly writer: string;
  readonly content: string;
}): SessionScratchpadEntry {
  return {
    id: randomUUID(),
    ts: new Date().toISOString(),
    writer: input.writer,
    content: input.content,
  };
}

/**
 * Render entries as a compact text block for tool output / future
 * system-prompt injection. Groups consecutive entries from the same
 * writer for legibility.
 */
export function renderSessionScratchpad(entries: ReadonlyArray<SessionScratchpadEntry>): string {
  if (entries.length === 0) return "(session scratchpad is empty)";
  const lines: string[] = [];
  for (const e of entries) {
    lines.push(`[${e.ts}] (${e.writer})`);
    lines.push(e.content);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}
