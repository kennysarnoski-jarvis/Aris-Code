/**
 * TodosMemory — project-scoped structured todo list for DeepSeek,
 * backed by an append-only `.jsonl` file.
 *
 * Slice MEM-2: Second port from Aris's tool surface (after MEM-1's
 * scratchpad). Same receptacle move (sqlite + graph → jsonl + replay)
 * and same project-scoping rules. Todos are explicit discrete tasks
 * with status, distinct from the scratchpad's freeform working notes.
 *
 * Layout (cohabits the same project dir as scratchpad + future facts):
 *
 *   ~/.aris/projects/<project-key>/
 *     scratchpad.jsonl                  ← MEM-1
 *     todos.jsonl                       ← THIS module's file
 *     facts.jsonl                       ← MEM-3 (deferred)
 *     sessions/<thread-id>/active.jsonl ← rolling-window (already shipped)
 *
 * Project-scoped, NOT thread-scoped: same as scratchpad. Todos are
 * "what's outstanding for THIS project," not per-conversation.
 *
 * Format — one JSON object per line, append-only:
 *
 *   { "id":"<uuid>", "ts":"<iso>", "action":"add",        "todoId": 1, "text": "fix login" }
 *   { "id":"<uuid>", "ts":"<iso>", "action":"set_status", "todoId": 1, "status": "in_progress" }
 *   { "id":"<uuid>", "ts":"<iso>", "action":"clear",      "onlyCompleted": false }
 *
 * Two ids per record:
 *   - `id` (uuid) — audit log identity for THIS mutation
 *   - `todoId` (int) — user-facing reference for the actual todo
 *     (assigned at add-time as max(prior todoIds) + 1, never reused)
 *
 * Why the int `todoId` instead of just using the uuid: the model
 * needs to type the id back when calling set_status. Short ints
 * (`12`) are far less error-prone than 36-char uuids. We assign at
 * add-time so the assignment is replay-deterministic.
 *
 * Replay rules (current state derived from the record stream):
 *   - `add(todoId, text)`              → push { id: todoId, text, status: "pending" }
 *   - `set_status(todoId, status)`     → patch matching todo (no-op if missing)
 *   - `clear({ onlyCompleted: true })` → drop completed todos
 *   - `clear({ onlyCompleted: false })`→ drop all todos
 *
 * Completed todos stay on disk forever (audit log property) but are
 * filtered out of the auto-injected `<todos>` system block —
 * "open todos only" matches Aris's UX so the model doesn't waste
 * context on done work.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { Data } from "effect";

import { ensureProjectDir, getProjectDir } from "./ScratchpadMemory.ts";

const TODOS_FILENAME = "todos.jsonl";

/**
 * Tagged error for any todos I/O failure. Mirrors the pattern in
 * `ScratchpadMemory` and `RollingWindowMemory` so callers can use
 * `Effect.tryPromise.catch` without leaking raw `unknown` into Effect's
 * error channel (Effect v4 lints against that).
 */
export class TodosIOError extends Data.TaggedError("TodosIOError")<{
  readonly operation: "read" | "append" | "mkdir";
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * `Effect.tryPromise.catch` adapter — wraps an unknown thrown value
 * into a tagged `TodosIOError`.
 */
export function toTodosIOError(operation: "read" | "append" | "mkdir") {
  return (cause: unknown): TodosIOError =>
    new TodosIOError({
      operation,
      message: cause instanceof Error ? cause.message : String(cause),
      cause,
    });
}

/** Possible statuses for a todo. Mirrors Aris's three-state model. */
export type TodoStatus = "pending" | "in_progress" | "completed";

/**
 * One persisted mutation to the todos list. Discriminated union on
 * `action` so the parser doesn't need separate factories.
 */
export type TodosRecord =
  | {
      readonly id: string;
      readonly ts: string;
      readonly action: "add";
      readonly todoId: number;
      readonly text: string;
    }
  | {
      readonly id: string;
      readonly ts: string;
      readonly action: "set_status";
      readonly todoId: number;
      readonly status: TodoStatus;
    }
  | {
      readonly id: string;
      readonly ts: string;
      readonly action: "clear";
      readonly onlyCompleted: boolean;
    };

/** Current-state shape after replay — what callers actually consume. */
export interface Todo {
  readonly id: number;
  readonly text: string;
  readonly status: TodoStatus;
}

/** Path to the project's todos file. Pure path math — no fs touch. */
export function getTodosPath(cwd: string): string {
  return join(getProjectDir(cwd), TODOS_FILENAME);
}

/**
 * Parse one line into a `TodosRecord`. Returns `null` for any line
 * that doesn't match the expected shape. Caller drops nulls with a
 * console warning rather than throwing — single-line corruption
 * shouldn't break the whole list.
 */
function parseRecord(line: string): TodosRecord | null {
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
  if (action === "add") {
    const todoId = obj["todoId"];
    const text = obj["text"];
    if (typeof todoId !== "number" || !Number.isFinite(todoId)) return null;
    if (typeof text !== "string") return null;
    return { id, ts, action, todoId, text };
  }
  if (action === "set_status") {
    const todoId = obj["todoId"];
    const status = obj["status"];
    if (typeof todoId !== "number" || !Number.isFinite(todoId)) return null;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return null;
    return { id, ts, action, todoId, status };
  }
  if (action === "clear") {
    const onlyCompleted = obj["onlyCompleted"];
    if (typeof onlyCompleted !== "boolean") return null;
    return { id, ts, action, onlyCompleted };
  }
  return null;
}

/**
 * Read the raw record stream from disk in file order. Returns `[]`
 * for a missing file (no todos activity yet for this project).
 */
export async function readTodosRecords(cwd: string): Promise<ReadonlyArray<TodosRecord>> {
  const path = getTodosPath(cwd);
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const out: TodosRecord[] = [];
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const record = parseRecord(line);
    if (record === null) {
      console.warn(`[TodosMemory] dropped corrupt line in ${path}: ${line.slice(0, 80)}…`);
      continue;
    }
    out.push(record);
  }
  return out;
}

/**
 * Replay records in file order to derive the current todo list. Pure
 * function on the record array — separated from IO so tests can verify
 * replay rules without touching disk.
 *
 * Replay rules:
 *   - `add(todoId, text)`              → push { id: todoId, text, status: "pending" }
 *   - `set_status(todoId, status)`     → patch matching todo; no-op if missing
 *   - `clear({ onlyCompleted: true })` → keep only non-completed todos
 *   - `clear({ onlyCompleted: false })`→ wipe everything
 *
 * `add` with a duplicate `todoId` (shouldn't happen with monotonic id
 * allocation but defensive against hand-edited files): the LATER entry
 * wins. We replace the prior todo at that id rather than push a dup.
 */
export function replayTodos(records: ReadonlyArray<TodosRecord>): ReadonlyArray<Todo> {
  let todos: Todo[] = [];
  for (const r of records) {
    if (r.action === "add") {
      const existingIdx = todos.findIndex((t) => t.id === r.todoId);
      const fresh: Todo = { id: r.todoId, text: r.text, status: "pending" };
      if (existingIdx >= 0) {
        todos = todos.map((t, i) => (i === existingIdx ? fresh : t));
      } else {
        todos = [...todos, fresh];
      }
    } else if (r.action === "set_status") {
      todos = todos.map((t) => (t.id === r.todoId ? { ...t, status: r.status } : t));
    } else {
      todos = r.onlyCompleted ? todos.filter((t) => t.status !== "completed") : [];
    }
  }
  return todos;
}

/** Convenience: read the file and replay in one call. */
export async function readTodos(cwd: string): Promise<ReadonlyArray<Todo>> {
  const records = await readTodosRecords(cwd);
  return replayTodos(records);
}

/**
 * Compute the next `todoId` to assign on an `add`. Walks the record
 * stream and takes max(todoId from add records) + 1. Starts at 1 for
 * the first todo in a fresh project. Cleared-and-re-added projects get
 * IDs that continue from the historical max — todoIds are never
 * recycled, even after a `clear`. This keeps cross-thread references
 * stable: if a thread mentions "todo 5" in archived conversation, it
 * always meant the same todo at insert time, even if it's since been
 * cleared.
 */
export function nextTodoId(records: ReadonlyArray<TodosRecord>): number {
  let max = 0;
  for (const r of records) {
    if (r.action === "add" && r.todoId > max) max = r.todoId;
  }
  return max + 1;
}

/**
 * Append one record to the todos file. Atomic at the line level
 * (O_APPEND) and fsynced via `flush: true`. Mirrors
 * `appendScratchpadRecord`.
 *
 * NOTE on concurrency: the file write itself is atomic, but the
 * read-modify-write sequence in the tool layer (read records → compute
 * nextTodoId → append) is NOT — concurrent `add` calls can all read
 * the same prior state, compute the same id, and write conflicting
 * records. Use `withTodosWriteLock` in the tool layer to serialize.
 */
export async function appendTodosRecord(cwd: string, record: TodosRecord): Promise<void> {
  await ensureProjectDir(cwd);
  const line = JSON.stringify(record) + "\n";
  await fs.appendFile(getTodosPath(cwd), line, { encoding: "utf8", flush: true });
}

/**
 * Per-project write lock map. Keyed on the project directory so two
 * writes within the same project serialize, but writes across
 * different projects don't block each other.
 *
 * Why this exists: the OpenAI Agents SDK runs tool calls concurrently
 * when the model emits multiple in a single assistant turn. Without
 * serialization, N parallel `add` calls all do
 *   const records = await readTodosRecords(cwd);
 *   const newId = nextTodoId(records);
 *   await appendTodosRecord(cwd, { todoId: newId, ... });
 * at roughly the same time, all read the same prior state, all
 * compute the same `newId`, and all write records with duplicate
 * todoIds. Replay then collapses them to a single todo.
 *
 * Module-level Map is fine because each Aris Code instance is a
 * single Node.js process — no inter-process concurrency to worry about.
 */
const PROJECT_WRITE_LOCKS = new Map<string, Promise<unknown>>();

/**
 * Serialize an async write against any other in-flight write to the
 * same project's todos.jsonl. Use this around any read-modify-write
 * tool path (currently `add`; defensively wrap `set_status` and
 * `clear` too so the "current state shown after the write" report
 * stays consistent under concurrency).
 *
 * Implementation: chain our work after the prior promise. Using
 * `.then(onFulfilled, onRejected)` with both handlers means a
 * rejected prior write doesn't poison subsequent calls.
 */
export async function withTodosWriteLock<T>(cwd: string, fn: () => Promise<T>): Promise<T> {
  const key = getProjectDir(cwd);
  const prior = PROJECT_WRITE_LOCKS.get(key) ?? Promise.resolve();
  const ours = prior.then(
    () => fn(),
    () => fn(),
  );
  // Replace the head with our promise. Suppress rejection on the
  // stored value so a failed write doesn't leave the map in a
  // permanently-rejected state for that project.
  PROJECT_WRITE_LOCKS.set(
    key,
    ours.catch(() => undefined),
  );
  return await ours;
}

/**
 * Build a `TodosRecord` with a fresh uuid + timestamp. Tool layer uses
 * this so it doesn't have to import `crypto` or know the time-clock
 * shape. Caller supplies the discriminated payload (action + fields).
 */
export function newTodosRecord(
  input:
    | { readonly action: "add"; readonly todoId: number; readonly text: string }
    | { readonly action: "set_status"; readonly todoId: number; readonly status: TodoStatus }
    | { readonly action: "clear"; readonly onlyCompleted: boolean },
): TodosRecord {
  const id = randomUUID();
  const ts = new Date().toISOString();
  if (input.action === "add") {
    return { id, ts, action: "add", todoId: input.todoId, text: input.text };
  }
  if (input.action === "set_status") {
    return { id, ts, action: "set_status", todoId: input.todoId, status: input.status };
  }
  return { id, ts, action: "clear", onlyCompleted: input.onlyCompleted };
}

/**
 * Render the current open-todo list (pending + in_progress only) as a
 * compact text block for the system prompt. Completed todos are hidden
 * — the model shouldn't waste context on done work, and the file still
 * has the audit trail for `clear --only-completed` housekeeping.
 *
 * Returns the empty string when there are no open todos, so the
 * adapter can decide to skip the `<todos>` block entirely (no point
 * in injecting an empty section).
 */
export function renderOpenTodos(todos: ReadonlyArray<Todo>): string {
  const open = todos.filter((t) => t.status !== "completed");
  if (open.length === 0) return "";
  return open.map((t) => `[${t.id}] [${t.status}] ${t.text}`).join("\n");
}
