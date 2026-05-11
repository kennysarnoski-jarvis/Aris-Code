/**
 * ProjectTodosPanel — right-sidebar panel showing the project's open
 * todos for the current DS thread.
 *
 * Slice COORD-6.3: Reads the latest `manage_todos` tool result from
 * the aris event stream and parses out the open-todos block. The
 * tool result format (from DeepSeekTodosTool.execute) is:
 *
 *   Added todo 1: ...
 *
 *   Current open todos:
 *   [1] [pending] fix login bug
 *   [2] [in_progress] refactor auth
 *
 * V1 limitation: tool result preview is capped at 500 chars
 * server-side, so very long todo lists may be truncated. We accept
 * that for now — adding a dedicated RPC for fresh todo state is V2
 * if it bites in practice.
 *
 * Empty state: when no manage_todos call has fired this session, the
 * panel shows a placeholder. Aris's first todo write populates it.
 *
 * @module ProjectTodosPanel
 */
import { useEffect, useMemo, useState } from "react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { readEnvironmentApi } from "../environmentApi";

interface ParsedTodo {
  readonly id: string;
  readonly status: string;
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
  const [latestResult, setLatestResult] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled || !threadId || !environmentId) {
      setLatestResult(null);
      return;
    }
    const api = readEnvironmentApi(environmentId);
    if (!api) return;

    const unsubscribe = api.aris.subscribeEvents({ threadId }, (event) => {
      // Filter to manage_todos completions only. The result preview
      // contains the post-write open-todos block we parse below.
      if (event.type === "aris.tool.started" && event.payload.name === "manage_todos") {
        // No-op on start; just observed for future "in flight" UX.
        return;
      }
      if (event.type !== "aris.tool.completed") return;
      // We don't have the tool name on completed events directly —
      // they only have toolCallId + status + resultPreview. To filter
      // by tool name we'd need to track callId↔name from the
      // matching started event. Cheapest heuristic: parse the result
      // and only update if it CONTAINS the "Current open todos:"
      // marker. False matches are practically impossible.
      const preview = event.payload.resultPreview ?? "";
      if (
        preview.includes("Current open todos:") ||
        preview.includes("Current open todos") ||
        preview.startsWith("Cleared") ||
        preview.startsWith("No todos")
      ) {
        setLatestResult(preview);
      }
    });
    return () => {
      unsubscribe();
    };
  }, [enabled, environmentId, threadId]);

  const todos = useMemo<ReadonlyArray<ParsedTodo>>(
    () => (latestResult ? parseOpenTodos(latestResult) : []),
    [latestResult],
  );

  if (!enabled) return null;

  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400 px-3">
        Project todos {todos.length > 0 ? `(${todos.length})` : ""}
      </div>
      {todos.length === 0 ? (
        <div className="text-xs text-zinc-500 dark:text-zinc-400 italic px-3 py-2">
          {latestResult ? "No open todos." : "No todos written this session."}
        </div>
      ) : (
        <ul className="flex flex-col">
          {todos.map((t) => (
            <li
              key={t.id}
              className="px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/40 flex items-start gap-2"
            >
              <TodoStatusPill status={t.status} />
              <span className="text-xs text-zinc-800 dark:text-zinc-200 flex-1 break-words">
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
 * Parse `[id] [status] text` lines out of a manage_todos result
 * preview. Returns only OPEN todos (pending + in_progress);
 * completed entries are filtered out (they're hidden from the
 * panel for the same reason they're hidden from the system prompt).
 *
 * Tolerant to surrounding text — the result has prose like
 * "Added todo 1: foo\n\nCurrent open todos:\n[1] ..." and we just
 * scan for the bracketed id+status+text pattern.
 */
function parseOpenTodos(text: string): ReadonlyArray<ParsedTodo> {
  const lineRe = /^\[(\d+)\]\s*\[(pending|in_progress|completed)\]\s*(.+)$/;
  const out: ParsedTodo[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    const m = line.match(lineRe);
    if (!m) continue;
    const status = m[2] ?? "";
    if (status === "completed") continue;
    out.push({ id: m[1] ?? "", status, text: m[3]?.trim() ?? "" });
  }
  return out;
}

function TodoStatusPill({ status }: { status: string }) {
  const { label, classes } = todoStatusPresentation(status);
  return (
    <span
      className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${classes} flex-shrink-0 mt-0.5`}
    >
      {label}
    </span>
  );
}

function todoStatusPresentation(status: string): { label: string; classes: string } {
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
    default:
      return {
        label: status,
        classes: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
      };
  }
}
