/**
 * useArisCoordinatorEvents — React hook that accumulates per-turn
 * coordinator activity for the active DS thread.
 *
 * Consumes three event types from the Aris event channel:
 *   - `aris.worker.spawn.started` — create a "running" worker entry
 *   - `aris.worker.spawn.completed` — flip to terminal status
 *     (ok / failed / budget_exceeded / escalated)
 *   - `aris.session_scratchpad.appended` — append entry to feed
 *
 * Per-turn scoping: state automatically resets when a new
 * `aris.turn.started` event arrives (or when the user switches
 * threads). The right-sidebar CoordinatorActivityPanel renders the
 * current turn only — past coordinator sessions live on disk and can
 * be re-opened from a future history view.
 *
 * Source: same `EnvironmentApi["aris"]["subscribeEvents"]` route the
 * existing useArisToolEvents hook uses. DS publishes through the same
 * channel (`publishArisEvent` in `DeepSeekAdapter` ⇒
 * `ArisEventBus.streamForThread`).
 *
 * @module useArisCoordinatorEvents
 */
import { useEffect, useState } from "react";

import type {
  ArisToolCallId,
  ArisWorkerSpawnStatus,
  EnvironmentId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { readEnvironmentApi } from "./environmentApi";

export interface CoordinatorWorkerState {
  readonly workerCallId: ArisToolCallId;
  readonly description: string;
  readonly status: "running" | ArisWorkerSpawnStatus;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly elapsedMs: number | null;
  readonly toolCalls: number | null;
  readonly outputBytes: number | null;
  readonly toolNames: ReadonlyArray<string>;
  readonly turnCap: number | null;
  readonly errorMessage: string | null;
}

export interface SessionScratchpadEntryView {
  readonly entryId: string;
  readonly writer: string;
  readonly content: string;
  readonly receivedAt: string;
}

export interface UseArisCoordinatorEventsOptions {
  readonly threadId: ThreadId | null;
  readonly environmentId: EnvironmentId | null;
  readonly provider: string | null;
}

export interface UseArisCoordinatorEventsResult {
  /** Active turn id — null when no turn has fired yet. */
  readonly currentTurnId: TurnId | null;
  /** Workers spawned in the current turn, in start order. */
  readonly workers: ReadonlyArray<CoordinatorWorkerState>;
  /** Session-scratchpad entries from the current turn. */
  readonly scratchpadEntries: ReadonlyArray<SessionScratchpadEntryView>;
}

const EMPTY_WORKERS: ReadonlyArray<CoordinatorWorkerState> = [];
const EMPTY_ENTRIES: ReadonlyArray<SessionScratchpadEntryView> = [];

export function useArisCoordinatorEvents(
  opts: UseArisCoordinatorEventsOptions,
): UseArisCoordinatorEventsResult {
  const { threadId, environmentId, provider } = opts;
  // Coordinator events only fire from the DeepSeek adapter today.
  // Aris-provider threads don't have spawn_worker; gating on
  // provider keeps unnecessary subscriptions from being created.
  const enabled = provider === "deepseek" && !!threadId && !!environmentId;

  const [currentTurnId, setCurrentTurnId] = useState<TurnId | null>(null);
  const [workersById, setWorkersById] = useState<
    ReadonlyMap<ArisToolCallId, CoordinatorWorkerState>
  >(() => new Map());
  const [scratchpadEntries, setScratchpadEntries] = useState<
    ReadonlyArray<SessionScratchpadEntryView>
  >(() => []);

  useEffect(() => {
    if (!enabled || !threadId || !environmentId) {
      setCurrentTurnId(null);
      setWorkersById(new Map());
      setScratchpadEntries([]);
      return;
    }

    const api = readEnvironmentApi(environmentId);
    if (!api) return;

    setCurrentTurnId(null);
    setWorkersById(new Map());
    setScratchpadEntries([]);

    const unsubscribe = api.aris.subscribeEvents({ threadId }, (event) => {
      // New parent turn → reset the panel state. We use turn.started
      // rather than worker.spawn.started so the panel clears even on
      // turns that don't end up spawning workers (covers the "previous
      // turn had workers, this one doesn't" case cleanly).
      if (event.type === "aris.turn.started") {
        setCurrentTurnId(event.turnId ?? null);
        setWorkersById(new Map());
        setScratchpadEntries([]);
        return;
      }

      if (event.type === "aris.worker.spawn.started") {
        const next: CoordinatorWorkerState = {
          workerCallId: event.payload.workerCallId,
          description: event.payload.description,
          status: "running",
          startedAt: event.createdAt,
          completedAt: null,
          elapsedMs: null,
          toolCalls: null,
          outputBytes: null,
          toolNames: event.payload.toolNames,
          turnCap: event.payload.turnCap,
          errorMessage: null,
        };
        setWorkersById((prev) => {
          const updated = new Map(prev);
          updated.set(event.payload.workerCallId, next);
          return updated;
        });
        return;
      }

      if (event.type === "aris.worker.spawn.completed") {
        setWorkersById((prev) => {
          const existing = prev.get(event.payload.workerCallId);
          // If we missed the started event somehow, synthesize a
          // minimal base so the terminal state still renders.
          const base: CoordinatorWorkerState = existing ?? {
            workerCallId: event.payload.workerCallId,
            description: event.payload.description,
            status: "running",
            startedAt: event.createdAt,
            completedAt: null,
            elapsedMs: null,
            toolCalls: null,
            outputBytes: null,
            toolNames: [],
            turnCap: null,
            errorMessage: null,
          };
          const updated = new Map(prev);
          updated.set(event.payload.workerCallId, {
            ...base,
            status: event.payload.status,
            completedAt: event.createdAt,
            elapsedMs: event.payload.elapsedMs,
            toolCalls: event.payload.toolCalls,
            outputBytes: event.payload.outputBytes,
            errorMessage: event.payload.errorMessage ?? null,
          });
          return updated;
        });
        return;
      }

      if (event.type === "aris.session_scratchpad.appended") {
        setScratchpadEntries((prev) => [
          ...prev,
          {
            entryId: event.payload.entryId,
            writer: event.payload.writer,
            content: event.payload.content,
            receivedAt: event.createdAt,
          },
        ]);
        return;
      }
    });

    return () => {
      unsubscribe();
    };
  }, [enabled, environmentId, threadId]);

  const workers = enabled ? Array.from(workersById.values()) : EMPTY_WORKERS;
  return {
    currentTurnId,
    workers,
    scratchpadEntries: enabled ? scratchpadEntries : EMPTY_ENTRIES,
  };
}
