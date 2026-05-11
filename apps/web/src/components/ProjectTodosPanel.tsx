/**
 * ProjectTodosPanel — right-sidebar panel showing the project's todos
 * for the current DS thread.
 *
 * Slice COORD-6.3 (initial): renders open todos parsed from the latest
 * `manage_todos` tool result preview.
 *
 * 2026-05-11 update — persist completed todos with strikethrough:
 *   Aris's tool result only includes OPEN todos (by design: keeps the
 *   model's per-turn context focused on what's left). When a todo flips
 *   to `completed` it drops out of the result preview and the panel
 *   would otherwise just *vanish* it — disorienting. Cowork's TodoList
 *   keeps completed items visible with a strikethrough so the user can
 *   see their progress; we mirror that pattern here.
 *
 *   How it works:
 *     - State is an in-memory Map<id, TrackedTodo> scoped to the active
 *       thread (resets when threadId changes — matches user mental model
 *       of "new thread = fresh list").
 *     - Every `manage_todos` tool result re-parses the open list. Todos
 *       in the parsed list update / get inserted. Todos that were
 *       previously open in the Map but absent from this parse are
 *       inferred to have completed and are flipped to `completed` in
 *       place, retaining their text from the last time we saw them.
 *     - A "Cleared all todos." result wipes the map. A "Clear completed"
 *       button is rendered when at least one completed entry exists; it
 *       drops completed entries client-side (server-side they still
 *       persist in the jsonl unless the user explicitly asks Aris to
 *       run `manage_todos({mode:"clear", only_completed:true})`).
 *
 *   Limitation: if the panel wasn't mounted when a todo flipped from
 *   open → completed, that transition isn't captured (we never saw the
 *   open state to track). In practice the panel is always mounted while
 *   the user is in a DS thread, so this only bites if the user switches
 *   threads and returns — same UX as Cowork's TodoList.
 *
 * @module ProjectTodosPanel
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { readEnvironmentApi } from "../environmentApi";

type TrackedStatus = "pending" | "in_progress" | "completed";

interface TrackedTodo {
  readonly id: string;
  readonly status: TrackedStatus;
  readonly text: string;
}

interface ParsedOpenTodo {
  readonly id: string;
  readonly status: Exclude<TrackedStatus, "completed">;
  readonly text: string;
}

export interface ProjectTodosPanelProps {
  readonly threadId: ThreadId | null;
  readonly environmentId: EnvironmentId | null;
  readonly provider: string | null;
}

export function ProjectTodosPanel(props: ProjectTodosPanelProps) {
  const { threadId, environmentId, provider } = props;
  const enabled = provider === "deepseek" && !!threadId && !!environmentId;
  const [trackedTodos, setTrackedTodos] = useState<ReadonlyMap<string, TrackedTodo>>(
    () => new Map(),
  );

  // Resets the tracked-todos map whenever the active thread changes
  // (and on unmount). Each thread gets its own fresh slate.
  useEffect(() => {
    if (!enabled || !threadId || !environmentId) {
      setTrackedTodos(new Map());
      return;
    }
    // Reset on (re)subscribe so switching threads always starts clean.
    setTrackedTodos(new Map());

    const api = readEnvironmentApi(environmentId);
    if (!api) return;

    const unsubscribe = api.aris.subscribeEvents({ threadId }, (event) => {
      if (event.type !== "aris.tool.completed") return;
      const preview = event.payload.resultPreview ?? "";

      // "Cleared all todos." → wipe map entirely. The user (via Aris)
      // asked for a hard reset; honor it in the UI too.
      if (preview.startsWith("Cleared all todos")) {
        setTrackedTodos(new Map());
        return;
      }

      // Heuristic: only `manage_todos` results contain "Current open
      // todos" or the `Cleared completed` marker. Other tool results
      // never match and pass through harmlessly.
      const containsTodoMarker =
        preview.includes("Current open todos") || preview.startsWith("Cleared completed");
      if (!containsTodoMarker) return;

      const parsedOpen = parseOpenTodos(preview);
      setTrackedTodos((prev) => reconcileTrackedTodos(prev, parsedOpen));
    });
    return () => {
      unsubscribe();
    };
  }, [enabled, environmentId, threadId]);

  const orderedTodos = useMemo<ReadonlyArray<TrackedTodo>>(
    () => orderTrackedTodos(trackedTodos),
    [trackedTodos],
  );

  const completedCount = useMemo(
    () => orderedTodos.filter((t) => t.status === "completed").length,
    [orderedTodos],
  );

  const onClearCompleted = useCallback(() => {
    setTrackedTodos((prev) => {
      const next = new Map(prev);
      for (const [id, todo] of next) {
        if (todo.status === "completed") next.delete(id);
      }
      return next;
    });
  }, []);

  if (!enabled) return null;

  const openCount = orderedTodos.length - completedCount;

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400 px-3 flex items-center justify-between">
        <span>Project todos {openCount > 0 ? `(${openCount})` : ""}</span>
        {completedCount > 0 && (
          <button
            type="button"
            onClick={onClearCompleted}
            className="text-[10px] normal-case tracking-normal text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors"
            title="Hide completed todos from this panel (server-side history is preserved)"
          >
            Clear completed
          </button>
        )}
      </div>
      {orderedTodos.length === 0 ? (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 italic px-3 py-2">
          No todos written this session.
        </div>
      ) : (
        <ul className="flex flex-col">
          {orderedTodos.map((t) => (
            <li
              key={t.id}
              className="px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/40 flex items-start gap-2"
            >
              <TodoStatusPill status={t.status} />
              <span
                className={`text-xs flex-1 break-words ${
                  t.status === "completed"
                    ? "text-zinc-400 dark:text-zinc-500 line-through"
                    : "text-zinc-800 dark:text-zinc-200"
                }`}
              >
                {t.text}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Merge the latest parsed open-todo list into the tracked map.
 *   - Open todos in the parse: insert / update text and status.
 *   - Tracked todos absent from the parse, currently open: flip to
 *     `completed` while retaining their last-known text.
 *   - Tracked todos absent from the parse, already completed: untouched.
 */
function reconcileTrackedTodos(
  prev: ReadonlyMap<string, TrackedTodo>,
  parsedOpen: ReadonlyArray<ParsedOpenTodo>,
): ReadonlyMap<string, TrackedTodo> {
  const next = new Map(prev);
  const parsedIds = new Set<string>();

  for (const todo of parsedOpen) {
    parsedIds.add(todo.id);
    next.set(todo.id, todo);
  }

  for (const [id, existing] of prev) {
    if (parsedIds.has(id)) continue;
    if (existing.status === "completed") continue;
    // Was open last time we saw it, gone from the open list now → infer
    // completion. (`clear --only_completed` would also drop entries
    // that were already completed; those don't reach this branch.)
    next.set(id, { ...existing, status: "completed" });
  }

  return next;
}

/** Sort: open todos first (by numeric id ascending), then completed (by numeric id ascending). */
function orderTrackedTodos(map: ReadonlyMap<string, TrackedTodo>): ReadonlyArray<TrackedTodo> {
  const todos = Array.from(map.values());
  return todos.sort((a, b) => {
    const aOpen = a.status !== "completed" ? 0 : 1;
    const bOpen = b.status !== "completed" ? 0 : 1;
    if (aOpen !== bOpen) return aOpen - bOpen;
    return Number(a.id) - Number(b.id);
  });
}

/**
 * Parse `[id] [status] text` lines out of a manage_todos result
 * preview. Returns ONLY open entries — the result format only ever
 * includes opens, and the parser doubles down on that contract so a
 * stray `completed` line (if the backend's render ever changes) can't
 * accidentally insert a non-strikethrough completed row.
 */
function parseOpenTodos(text: string): ReadonlyArray<ParsedOpenTodo> {
  const lineRe = /^\[(\d+)\]\s*\[(pending|in_progress|completed)\]\s*(.+)$/;
  const out: ParsedOpenTodo[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const m = line.match(lineRe);
    if (!m) continue;
    const status = m[2] ?? "";
    if (status !== "pending" && status !== "in_progress") continue;
    out.push({ id: m[1] ?? "", status, text: m[3]?.trim() ?? "" });
  }
  return out;
}

function TodoStatusPill({ status }: { status: TrackedStatus }) {
  const { label, classes } = todoStatusPresentation(status);
  return (
    <span
      className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${classes} flex-shrink-0 mt-0.5`}
    >
      {label}
    </span>
  );
}

function todoStatusPresentation(status: TrackedStatus): { label: string; classes: string } {
  switch (status) {
    case "pending":
      return {
        label: "pending",
        classes: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
      };
    case "in_progress":
      return {
        label: "in flight",
        classes: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
      };
    case "completed":
      return {
        label: "done",
        classes:
          "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300 opacity-70",
      };
  }
}
