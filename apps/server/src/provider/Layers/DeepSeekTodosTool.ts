/**
 * DeepSeekTodosTool — DS's `manage_todos` tool, backed by the project-
 * scoped jsonl in `TodosMemory`.
 *
 * Slice MEM-2: Mirrors Aris's `manage_todos` tool surface 1:1 (modes:
 * add / set_status / list / clear). The model's prior fluency carries
 * over without re-prompting.
 *
 * NOT registered for Aris-provider threads — Aris has its own
 * `manage_todos` rooted in `aris_memory.db`. Adding this DS tool to
 * Aris would write to two stores in parallel — exactly the receptacle
 * confusion this slice exists to eliminate.
 *
 * @module DeepSeekTodosTool
 */
import { tool } from "@openai/agents";
import { z } from "zod";

import {
  appendTodosRecord,
  newTodosRecord,
  nextTodoId,
  readTodos,
  readTodosRecords,
  renderOpenTodos,
  withTodosWriteLock,
  type Todo,
} from "./TodosMemory.ts";

export interface TodosToolContext {
  /** Workspace cwd — used to derive `~/.aris/projects/<key>/todos.jsonl`. */
  readonly cwd: string;
}

/** Format a single todo line for tool output. Same shape as renderOpenTodos uses. */
function formatTodoLine(t: Todo): string {
  return `[${t.id}] [${t.status}] ${t.text}`;
}

/**
 * Render the full list (open + completed) for the `list` mode return.
 * Distinct from `renderOpenTodos` which hides completed for the
 * system-prompt block — `list` is an explicit query, the model wants
 * to see everything when it asks.
 */
function renderAllTodos(todos: ReadonlyArray<Todo>): string {
  if (todos.length === 0) return "No todos in this project yet.";
  return todos.map(formatTodoLine).join("\n");
}

/**
 * Build the `manage_todos` tool. Single-element array to match the
 * composition shape used by `createDeepSeekArchiveTools` and
 * `createDeepSeekScratchpadTool`, so the composer in
 * `DeepSeekAgentTools` can `[...base, ...archive, ...scratchpad,
 * ...todos]` uniformly.
 */
export function createDeepSeekTodosTool(ctx: TodosToolContext) {
  const manageTodos = tool({
    name: "manage_todos",
    description:
      "Read/write your structured todo list for this PROJECT. Distinct " +
      "from the scratchpad — the scratchpad is freeform working notes, " +
      "this is a list of discrete tasks with status. Use it whenever the " +
      "user gives you multi-step work, or whenever YOU break a request " +
      "into explicit steps and want to track progress across turns. Open " +
      "todos (status pending or in_progress) are auto-loaded into your " +
      "system prompt every turn (you'll see a `<todos>` block) so you " +
      "don't need to list them explicitly between actions. Persists across " +
      "every thread in this project.\n\n" +
      "Modes:\n" +
      "  - 'add' — create a new todo (status defaults to pending). " +
      "Requires `text`. Returns the assigned todo id.\n" +
      "  - 'set_status' — transition a todo's status (pending → " +
      "in_progress → completed). Requires `id` and `status`.\n" +
      "  - 'list' — return the full todo list including completed. " +
      "Read-only, no fields needed.\n" +
      "  - 'clear' — drop todos. Default drops everything; pass " +
      "`only_completed: true` to keep open work and sweep finished.",
    parameters: z.object({
      mode: z
        .enum(["add", "set_status", "list", "clear"])
        .describe(
          "'add' creates a new todo (requires text). 'set_status' updates " +
            "an existing todo (requires id + status). 'list' returns the " +
            "full list. 'clear' drops todos.",
        ),
      text: z
        .string()
        .nullable()
        .optional()
        .describe(
          "Task description for 'add' mode. Be concrete — 'fix login bug' " +
            "is better than 'work on auth'. Ignored for other modes; pass " +
            "null or omit.",
        ),
      id: z
        .number()
        .int()
        .nullable()
        .optional()
        .describe(
          "Todo id for 'set_status' mode (assigned by 'add' and shown in " +
            "the `<todos>` block). Ignored for other modes; pass null or omit.",
        ),
      status: z
        .enum(["pending", "in_progress", "completed"])
        .nullable()
        .optional()
        .describe(
          "New status for 'set_status' mode. Set to 'in_progress' when " +
            "starting work, 'completed' when done. Ignored for other modes; " +
            "pass null or omit.",
        ),
      only_completed: z
        .boolean()
        .nullable()
        .optional()
        .describe(
          "For 'clear' mode: if true, only drop completed todos (open work " +
            "survives). Default false (drop everything). Ignored for other " +
            "modes; pass null or omit.",
        ),
    }),
    async execute({ mode, text, id, status, only_completed }) {
      // `list` is read-only — no lock needed. It can run concurrently
      // with writes; the read might briefly miss an in-flight write but
      // any subsequent call sees the merged state.
      if (mode === "list") {
        const todos = await readTodos(ctx.cwd);
        return renderAllTodos(todos);
      }
      // All write paths serialize via the per-project lock so:
      //   1. `add` reads current records, computes nextTodoId, and
      //      appends without racing other concurrent adds.
      //   2. `set_status` and `clear` produce consistent
      //      "current state after the write" reports — the post-write
      //      replay reflects this call's mutation.
      // The OpenAI Agents SDK runs tool calls concurrently when the
      // model emits multiple in one assistant turn, so this matters
      // even for a single-process server.
      return await withTodosWriteLock(ctx.cwd, async () => {
        if (mode === "add") {
          if (typeof text !== "string" || text.length === 0) {
            return "Mode 'add' requires a non-empty 'text' string.";
          }
          const records = await readTodosRecords(ctx.cwd);
          const newId = nextTodoId(records);
          await appendTodosRecord(ctx.cwd, newTodosRecord({ action: "add", todoId: newId, text }));
          return `Added todo ${newId}: ${text}\n\nCurrent open todos:\n${renderOpenTodos(await readTodos(ctx.cwd)) || "(none)"}`;
        }
        if (mode === "set_status") {
          if (typeof id !== "number" || !Number.isFinite(id)) {
            return "Mode 'set_status' requires a numeric 'id'.";
          }
          if (status !== "pending" && status !== "in_progress" && status !== "completed") {
            return "Mode 'set_status' requires 'status' to be one of: pending, in_progress, completed.";
          }
          // Don't fail loudly if the id doesn't exist — the replay is a
          // silent no-op. We DO probe so the model gets a useful error
          // rather than a misleading success.
          const before = await readTodos(ctx.cwd);
          if (!before.some((t) => t.id === id)) {
            return `No todo with id ${id} found. Use mode 'list' to see what exists.`;
          }
          await appendTodosRecord(
            ctx.cwd,
            newTodosRecord({ action: "set_status", todoId: id, status }),
          );
          return `Todo ${id} → ${status}\n\nCurrent open todos:\n${renderOpenTodos(await readTodos(ctx.cwd)) || "(none)"}`;
        }
        // mode === "clear"
        const onlyCompleted = only_completed === true;
        await appendTodosRecord(ctx.cwd, newTodosRecord({ action: "clear", onlyCompleted }));
        return onlyCompleted
          ? `Cleared completed todos.\n\nCurrent open todos:\n${renderOpenTodos(await readTodos(ctx.cwd)) || "(none)"}`
          : "Cleared all todos.";
      });
    },
  });

  return [manageTodos];
}
