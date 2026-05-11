/**
 * ScratchpadMemory — project-scoped freeform working notes for DeepSeek,
 * backed by an append-only `.jsonl` file.
 *
 * Slice MEM-1: First port from Aris's `update_scratchpad` tool. The
 * receptacle changed (sqlite + graph → jsonl + replay) but the user-
 * facing semantics stay the same: a freeform text buffer the model can
 * set / append / clear across turns within a project.
 *
 * Layout (mirrors the rolling-window pattern so all per-project state
 * cohabitates):
 *
 *   ~/.aris/projects/<project-key>/
 *     scratchpad.jsonl                  ← THIS module's file
 *     todos.jsonl                       ← MEM-2
 *     facts.jsonl                       ← MEM-3 (deferred)
 *     sessions/<thread-id>/active.jsonl ← rolling-window (already shipped)
 *     sessions/<thread-id>/window_NNN.* ← archives + summaries
 *
 * Project-scoped, NOT thread-scoped: matches Aris's `(user, project)`
 * scope. Since each Aris Code instance runs locally per user, the
 * `user` axis collapses out — every thread under the same workspace
 * cwd shares one scratchpad. That is intentional: the scratchpad is
 * for "what I'm working on in THIS project," not per-conversation.
 *
 * Format — one JSON object per line, append-only:
 *
 *   { "id": "...", "ts": "...", "action": "set",    "content": "..." }
 *   { "id": "...", "ts": "...", "action": "append", "content": "..." }
 *   { "id": "...", "ts": "...", "action": "clear" }
 *
 * Current state is derived by replaying records in file order:
 *   - `set`    → state = content
 *   - `append` → state = state ? state + "\n" + content : content
 *   - `clear`  → state = ""
 *
 * Why append-only instead of rewrite-on-write:
 *   - Atomic writes (O_APPEND) — no partial-file corruption window.
 *   - Auditable history — `cat scratchpad.jsonl` shows every change.
 *   - Same operational pattern as the rolling-window archives.
 *
 * Bounded growth: a project's scratchpad rarely exceeds a few hundred
 * records over its lifetime (set/append/clear are explicit user-or-
 * model actions, not high-frequency events). Replay cost is linear in
 * line count and stays in the milliseconds even at 10k records, so
 * compaction is not needed in V1.
 */
import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Data } from "effect";

import { projectKeyFromCwd } from "./RollingWindowMemory.ts";

const ARIS_HOME_DIR = ".aris";
const PROJECTS_SUBDIR = "projects";
const SCRATCHPAD_FILENAME = "scratchpad.jsonl";

/**
 * Tagged error for any scratchpad I/O failure. Mirrors
 * `RollingWindowIOError` so callers using `Effect.tryPromise.catch`
 * get a properly tagged narrow type (Effect v4 lints against returning
 * the global `Error` directly).
 */
export class ScratchpadIOError extends Data.TaggedError("ScratchpadIOError")<{
  readonly operation: "read" | "append" | "mkdir";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * `Effect.tryPromise.catch` adapter — wraps an unknown thrown value
 * into a tagged `ScratchpadIOError`. Used by every effectful caller
 * so we never let raw `unknown` leak into Effect's error channel.
 */
export function toScratchpadIOError(operation: "read" | "append" | "mkdir") {
  return (cause: unknown): ScratchpadIOError =>
    new ScratchpadIOError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
}

/**
 * One persisted scratchpad mutation. The discriminated union mirrors
 * the tool's `mode` enum so the parser doesn't need a translation step.
 *
 * `content` is required for `set` and `append`, absent for `clear`.
 */
export type ScratchpadRecord =
  | {
      readonly id: string;
      readonly ts: string;
      readonly action: "set";
      readonly content: string;
    }
  | {
      readonly id: string;
      readonly ts: string;
      readonly action: "append";
      readonly content: string;
    }
  | {
      readonly id: string;
      readonly ts: string;
      readonly action: "clear";
    };

/**
 * Path to the project's scratchpad file. Pure path math — no fs touch.
 */
export function getScratchpadPath(cwd: string): string {
  return join(
    homedir(),
    ARIS_HOME_DIR,
    PROJECTS_SUBDIR,
    projectKeyFromCwd(cwd),
    SCRATCHPAD_FILENAME,
  );
}

/**
 * Path to the project's directory (parent of scratchpad.jsonl). Useful
 * for `mkdir -p` before the first append. Exposed so MEM-2 (todos) and
 * MEM-3 (facts) can share the same directory without re-deriving.
 */
export function getProjectDir(cwd: string): string {
  return join(homedir(), ARIS_HOME_DIR, PROJECTS_SUBDIR, projectKeyFromCwd(cwd));
}

/**
 * Idempotent `mkdir -p` on the project directory. Safe to call before
 * every append.
 */
export async function ensureProjectDir(cwd: string): Promise<void> {
  await fs.mkdir(getProjectDir(cwd), { recursive: true });
}

/**
 * Parse one line into a `ScratchpadRecord`. Returns `null` for lines
 * that don't match the expected shape — caller drops them with a
 * warning rather than throwing, so a single corrupt line doesn't
 * break the whole replay.
 *
 * Note: `id` and `ts` are tolerated when missing only for back-compat
 * with manually-edited files; canonical writes always include them.
 */
function parseRecord(line: string): ScratchpadRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  const action = obj["action"];
  const id = typeof obj["id"] === "string" ? obj["id"] : "";
  const ts = typeof obj["ts"] === "string" ? obj["ts"] : "";
  if (action === "set" || action === "append") {
    if (typeof obj["content"] !== "string") return null;
    return { id, ts, action, content: obj["content"] };
  }
  if (action === "clear") {
    return { id, ts, action };
  }
  return null;
}

/**
 * Read the raw record stream from disk in file order. Returns `[]`
 * for a missing file (no scratchpad activity yet for this project).
 *
 * Lines that fail to parse are skipped with a console warning. The
 * append-only format means corruption is unlikely (no rewrites), but
 * defensive parsing costs nothing.
 */
export async function readScratchpadRecords(cwd: string): Promise<ReadonlyArray<ScratchpadRecord>> {
  const path = getScratchpadPath(cwd);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw err;
  }
  const out: ScratchpadRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const record = parseRecord(line);
    if (record === null) {
      console.warn(`[ScratchpadMemory] dropped corrupt line in ${path}: ${line.slice(0, 80)}…`);
      continue;
    }
    out.push(record);
  }
  return out;
}

/**
 * Replay records in file order to derive the current scratchpad text.
 * Pure function on the record array — separated from the IO so tests
 * can verify replay semantics without touching disk.
 *
 * Replay rules:
 *   - `set`    → state = record.content (overwrites everything prior)
 *   - `append` → state = state.length === 0
 *                  ? record.content
 *                  : state + "\n" + record.content
 *   - `clear`  → state = ""
 *
 * Returns the empty string for an empty record array.
 */
export function replayScratchpad(records: ReadonlyArray<ScratchpadRecord>): string {
  let state = "";
  for (const r of records) {
    if (r.action === "set") {
      state = r.content;
    } else if (r.action === "append") {
      state = state.length === 0 ? r.content : `${state}\n${r.content}`;
    } else {
      state = "";
    }
  }
  return state;
}

/**
 * Convenience: read the file and replay in one call. Returns the
 * empty string when no scratchpad has ever been written for this
 * project.
 */
export async function readScratchpad(cwd: string): Promise<string> {
  const records = await readScratchpadRecords(cwd);
  return replayScratchpad(records);
}

/**
 * Append one record to the scratchpad file. Atomic at the line level
 * (O_APPEND) and fsynced via `flush: true` so a crash mid-write loses
 * at most the last unflushed record rather than corrupting the file.
 */
export async function appendScratchpadRecord(cwd: string, record: ScratchpadRecord): Promise<void> {
  await ensureProjectDir(cwd);
  const line = JSON.stringify(record) + "\n";
  await fs.appendFile(getScratchpadPath(cwd), line, { encoding: "utf8", flush: true });
}

/**
 * Build a `ScratchpadRecord` with a fresh id + timestamp. Tool layer
 * uses this so it doesn't have to import `crypto` and the time clock
 * separately.
 */
export function newScratchpadRecord(
  input:
    | { readonly action: "set"; readonly content: string }
    | { readonly action: "append"; readonly content: string }
    | { readonly action: "clear" },
): ScratchpadRecord {
  const id = randomUUID();
  const ts = new Date().toISOString();
  if (input.action === "set" || input.action === "append") {
    return { id, ts, action: input.action, content: input.content };
  }
  return { id, ts, action: "clear" };
}
