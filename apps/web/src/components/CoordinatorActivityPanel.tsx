/**
 * CoordinatorActivityPanel — right-sidebar panel showing live workers
 * + session-scratchpad entries for the current parent turn.
 *
 * Slice COORD-6.2: Renders state from useArisCoordinatorEvents. Two
 * sections inside one panel:
 *   1. Workers — per-worker row with status pill + elapsed time +
 *      tool-call count + tool name list.
 *   2. Session scratchpad — per-entry row with writer attribution +
 *      truncated content + click-to-expand.
 *
 * Resets per parent turn (the hook handles that on
 * aris.turn.started).
 *
 * @module CoordinatorActivityPanel
 */
import { useEffect, useState } from "react";

import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useArisCoordinatorEvents } from "../useArisCoordinatorEvents";

export interface CoordinatorActivityPanelProps {
  readonly threadId: ThreadId | null;
  readonly environmentId: EnvironmentId | null;
  readonly provider: string | null;
}

export function CoordinatorActivityPanel(props: CoordinatorActivityPanelProps) {
  const { workers, scratchpadEntries } = useArisCoordinatorEvents(props);

  // Tick every second so running workers' elapsed timers update live.
  // Cheap — re-renders only the worker rows that depend on `now`.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const hasRunning = workers.some((w) => w.status === "running");
    if (!hasRunning) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [workers]);

  const hasContent = workers.length > 0 || scratchpadEntries.length > 0;

  if (!hasContent) {
    return (
      <div className="text-xs text-zinc-500 dark:text-zinc-400 italic px-3 py-2">
        No coordinator activity this turn.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {workers.length > 0 && (
        <section className="flex flex-col gap-1">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400 px-3">
            Workers ({workers.length})
          </div>
          <ul className="flex flex-col">
            {workers.map((w) => {
              const elapsedMs =
                w.elapsedMs != null
                  ? w.elapsedMs
                  : Math.max(0, now - new Date(w.startedAt).getTime());
              return (
                <li
                  key={w.workerCallId}
                  className="px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm truncate text-zinc-900 dark:text-zinc-100">
                      {w.description}
                    </span>
                    <StatusPill status={w.status} />
                  </div>
                  <div className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5 flex items-center gap-2 flex-wrap">
                    <span>{formatElapsed(elapsedMs)}</span>
                    {w.toolCalls != null && <span>· {w.toolCalls} tool calls</span>}
                    {/* 2026-05-11: surface the worker's turn budget so BUDGET
                        outcomes are interpretable. The cap is set per-worker
                        when Aris spawns it (default 50, see CoordinatorTypes).
                        Without this, "cap 25 vs cap 100" was invisible and
                        BUDGET looked like it fired at random tool-call
                        counts. */}
                    {w.turnCap != null && <span>· cap {w.turnCap} turns</span>}
                    {w.outputBytes != null && <span>· {formatBytes(w.outputBytes)}</span>}
                  </div>
                  {w.errorMessage && (
                    <div className="text-[11px] text-red-600 dark:text-red-400 mt-0.5 truncate">
                      {w.errorMessage}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {scratchpadEntries.length > 0 && (
        <section className="flex flex-col gap-1">
          <div className="text-[11px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400 px-3">
            Session scratchpad ({scratchpadEntries.length})
          </div>
          <ul className="flex flex-col">
            {scratchpadEntries.map((e) => (
              <ScratchpadEntryRow key={e.entryId} entry={e} />
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: "running" | string }) {
  const { label, classes } = statusPresentation(status);
  return (
    <span
      className={`text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded ${classes} flex-shrink-0`}
    >
      {label}
    </span>
  );
}

function statusPresentation(status: string): { label: string; classes: string } {
  switch (status) {
    case "running":
      return {
        label: "running",
        classes: "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
      };
    case "ok":
      return {
        label: "done",
        classes: "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
      };
    case "failed":
      return {
        label: "failed",
        classes: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
      };
    case "budget_exceeded":
      return {
        label: "budget",
        classes: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
      };
    case "escalated":
      return {
        label: "escalated",
        classes: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
      };
    default:
      return {
        label: status,
        classes: "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300",
      };
  }
}

function ScratchpadEntryRow({
  entry,
}: {
  entry: { entryId: string; writer: string; content: string; receivedAt: string };
}) {
  const [expanded, setExpanded] = useState(false);
  const preview = entry.content.length > 120 ? entry.content.slice(0, 120) + "…" : entry.content;
  return (
    <li className="px-3 py-1.5 hover:bg-zinc-50 dark:hover:bg-zinc-900/40">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full text-left flex flex-col gap-0.5"
      >
        <span className="text-[11px] text-zinc-500 dark:text-zinc-400">{entry.writer}</span>
        <span className="text-xs text-zinc-800 dark:text-zinc-200 whitespace-pre-wrap">
          {expanded ? entry.content : preview}
        </span>
      </button>
    </li>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rs = s % 60;
  return `${m}m ${rs}s`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
