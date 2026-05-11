/**
 * useArisToolEvents — React hook that accumulates per-tool-call state for
 * the active Aris thread by consuming `aris.tool.*` events from the
 * dedicated Aris event channel (Cut C, slice 3e-ii-c-1).
 *
 * Source: `EnvironmentApi["aris"]["subscribeEvents"]` → routes through the
 * WS `aris.subscribeEvents` RPC method to apps/server's
 * `ArisEventBus.streamForThread`.
 *
 * State shape: `Map<toolCallId, ArisToolCallState>`. Map is used so
 * insertion order is preserved (renderers want chronological ordering)
 * while keyed lookup-by-id stays O(1) for `progress`/`completed` updates.
 *
 * Event lifecycle:
 *   - `aris.tool.started`   → create entry with status: "running"
 *   - `aris.tool.progress`  → append message to `progressMessages`
 *   - `aris.tool.completed` → update status to "success" or "error",
 *                              fill `resultPreview` or `errorMessage`,
 *                              set `completedAt`
 *
 * Reset triggers (full state clear):
 *   - threadId change
 *   - environmentId change
 *   - provider switching to/from "aris"
 */
import { useCallback, useEffect, useState } from "react";

import type {
  ArisToolCallId,
  EnvironmentId,
  ThreadId,
  ToolLifecycleItemType,
  TurnId,
} from "@t3tools/contracts";

import { readEnvironmentApi } from "./environmentApi";
import type { WorkLogEntry } from "./session-logic";

export interface ArisToolCallState {
  readonly toolCallId: ArisToolCallId;
  readonly turnId: TurnId | null;
  readonly name: string;
  readonly args: Record<string, unknown>;
  readonly displayName: string | null;
  readonly status: "running" | "success" | "error";
  readonly progressMessages: ReadonlyArray<string>;
  readonly resultPreview: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
}

export interface UseArisToolEventsOptions {
  readonly threadId: ThreadId | null;
  readonly environmentId: EnvironmentId | null;
  readonly provider: string | null;
}

export interface UseArisToolEventsResult {
  /** All tool calls observed for this thread, in insertion order. */
  readonly toolCalls: ReadonlyArray<ArisToolCallState>;
  /** Lookup helper — O(1) by id. */
  readonly getById: (toolCallId: ArisToolCallId) => ArisToolCallState | undefined;
}

const EMPTY_TOOL_CALLS: ReadonlyArray<ArisToolCallState> = [];

export function useArisToolEvents(opts: UseArisToolEventsOptions): UseArisToolEventsResult {
  const { threadId, environmentId, provider } = opts;
  // DeepSeek shares ArisEventBus + emits the same `aris.tool.*`
  // events from DeepSeekAgentRunner. Gate both providers on.
  const enabled = (provider === "aris" || provider === "deepseek") && !!threadId && !!environmentId;

  const [toolCallsById, setToolCallsById] = useState<
    ReadonlyMap<ArisToolCallId, ArisToolCallState>
  >(() => new Map());

  useEffect(() => {
    if (!enabled || !threadId || !environmentId) {
      setToolCallsById(new Map());
      return;
    }

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    setToolCallsById(new Map());

    const unsubscribe = api.aris.subscribeEvents({ threadId }, (event) => {
      if (event.type === "aris.tool.started") {
        const next: ArisToolCallState = {
          toolCallId: event.payload.toolCallId,
          turnId: event.turnId ?? null,
          name: event.payload.name,
          args: event.payload.args,
          displayName: event.payload.displayName ?? null,
          status: "running",
          progressMessages: [],
          resultPreview: null,
          errorMessage: null,
          startedAt: event.createdAt,
          completedAt: null,
        };
        setToolCallsById((prev) => {
          const updated = new Map(prev);
          updated.set(event.payload.toolCallId, next);
          return updated;
        });
        return;
      }

      if (event.type === "aris.tool.progress") {
        setToolCallsById((prev) => {
          const existing = prev.get(event.payload.toolCallId);
          if (!existing) {
            // Progress event for an unknown tool call — likely arrived before
            // started (race) or the started event was missed. Drop silently;
            // the eventual `completed` event will create a final-state entry.
            return prev;
          }
          const updated = new Map(prev);
          updated.set(event.payload.toolCallId, {
            ...existing,
            progressMessages: [...existing.progressMessages, event.payload.message],
          });
          return updated;
        });
        return;
      }

      if (event.type === "aris.tool.completed") {
        setToolCallsById((prev) => {
          const existing = prev.get(event.payload.toolCallId);
          // If we have no `started` record (missed event), still record the
          // completion so the renderer can show a terminal-state card.
          const base: ArisToolCallState = existing ?? {
            toolCallId: event.payload.toolCallId,
            turnId: event.turnId ?? null,
            name: "tool_call",
            args: {},
            displayName: null,
            status: "running",
            progressMessages: [],
            resultPreview: null,
            errorMessage: null,
            startedAt: event.createdAt,
            completedAt: null,
          };
          const updated = new Map(prev);
          updated.set(event.payload.toolCallId, {
            ...base,
            status: event.payload.status === "success" ? "success" : "error",
            resultPreview: event.payload.resultPreview ?? null,
            errorMessage: event.payload.errorMessage ?? null,
            completedAt: event.createdAt,
          });
          return updated;
        });
        return;
      }
    });

    return () => {
      unsubscribe();
    };
  }, [enabled, environmentId, threadId]);

  const toolCalls = enabled ? Array.from(toolCallsById.values()) : EMPTY_TOOL_CALLS;
  const getById = useCallback(
    (toolCallId: ArisToolCallId) => toolCallsById.get(toolCallId),
    [toolCallsById],
  );

  return { toolCalls, getById };
}

// ── Synthesizer: ArisToolCallState → WorkLogEntry ──────────────────
//
// Cut C, slice 3e-ii-c-2: for Aris-provider threads the renderer reads
// `WorkLogEntry[]` synthesized from `aris.tool.*` events instead of the
// orchestration-derived activity stream. The shape is identical so
// `MessagesTimeline` / `RollingReasoning` / tool card rendering doesn't
// need to know which provider produced the entry.

const FILE_CHANGE_TOOL_NAMES = new Set<string>(["write_file", "edit_file"]);
const COMMAND_EXECUTION_TOOL_NAMES = new Set<string>(["bash"]);

function inferItemType(name: string): ToolLifecycleItemType | undefined {
  if (COMMAND_EXECUTION_TOOL_NAMES.has(name)) return "command_execution";
  if (FILE_CHANGE_TOOL_NAMES.has(name)) return "file_change";
  return undefined;
}

function deriveLabel(state: ArisToolCallState): string {
  if (state.displayName) return state.displayName;
  if (state.status === "error") return `${state.name || "tool_call"} failed`;
  if (state.status === "success") return `${state.name || "tool_call"} completed`;
  return `${state.name || "tool_call"} started`;
}

function deriveDetail(state: ArisToolCallState): string | undefined {
  if (state.errorMessage) return state.errorMessage;
  if (state.resultPreview) return state.resultPreview;
  // Args-derived fallback so in-flight cards still have something to show.
  const candidates: ReadonlyArray<unknown> = [
    state.args.path,
    state.args.file_path,
    state.args.pattern,
    state.args.query,
    state.args.url,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

function deriveCommand(state: ArisToolCallState): string | undefined {
  if (!COMMAND_EXECUTION_TOOL_NAMES.has(state.name)) return undefined;
  const candidates: ReadonlyArray<unknown> = [state.args.command, state.args.cmd];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Convert a single accumulated tool-call state into a `WorkLogEntry`
 * shaped exactly like the orchestration-derived ones, so the existing
 * timeline / rolling-reasoning / tool-card renderers don't need to
 * branch on provider.
 */
export function arisToolStateToWorkLogEntry(state: ArisToolCallState): WorkLogEntry {
  const tone: WorkLogEntry["tone"] = state.status === "error" ? "error" : "tool";
  const itemType = inferItemType(state.name);
  const detail = deriveDetail(state);
  const command = deriveCommand(state);

  const entry: WorkLogEntry = {
    id: state.toolCallId,
    createdAt: state.startedAt,
    label: deriveLabel(state),
    tone,
  };
  if (state.name) entry.toolTitle = state.name;
  if (itemType) entry.itemType = itemType;
  if (detail) entry.detail = detail;
  if (command) entry.command = command;
  return entry;
}
