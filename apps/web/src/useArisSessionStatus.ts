/**
 * useArisSessionStatus — React hook that synthesizes the active thread's
 * session state and most-recent turn for Aris-provider threads by
 * consuming `aris.session.*` and `aris.turn.*` events from the dedicated
 * Aris event channel (Cut C, slice 3e-iv-b-i).
 *
 * Replaces the orchestration-projection-derived `activeThread.session`
 * and `activeThread.latestTurn` for Aris threads only. Other providers
 * keep using the existing projection-fed state.
 *
 * Output shapes mirror `ThreadSession` and `OrchestrationLatestTurn`
 * exactly so downstream helpers (`derivePhase`, `isLatestTurnSettled`,
 * `deriveActiveWorkStartedAt`, etc.) work without any branching.
 *
 * Reducer (mirrors `ArisSessionRegistry.applyArisEvent` server-side):
 *   - `aris.session.started`           → status: "ready"
 *   - `aris.session.ended` (error)     → status: "error", clear activeTurnId
 *   - `aris.session.ended` (other)     → status: "ready", clear activeTurnId
 *   - `aris.turn.started`              → status: "running", set turn
 *   - `aris.turn.completed`            → status: "ready", complete turn
 *   - `aris.turn.failed`               → status: "error", complete turn (error)
 *   - `aris.turn.cancelled`            → status: "ready", complete turn (interrupted)
 *
 * Reset triggers (full state clear):
 *   - threadId / environmentId / provider change
 */
import { useEffect, useMemo, useState } from "react";

import type {
  EnvironmentId,
  OrchestrationLatestTurn,
  OrchestrationLatestTurnState,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";

import { readEnvironmentApi } from "./environmentApi";
import type { ThreadSession } from "./types";

interface ArisSessionStatusInternal {
  readonly status: ThreadSession["status"];
  readonly activeTurnId: TurnId | null;
  readonly lastError: string | null;
  // Latest turn (active or last-settled) — used to synthesize OrchestrationLatestTurn.
  readonly latestTurnId: TurnId | null;
  readonly latestTurnState: OrchestrationLatestTurnState | null;
  readonly latestTurnStartedAt: string | null;
  readonly latestTurnCompletedAt: string | null;
  readonly sessionCreatedAt: string;
  readonly updatedAt: string;
}

const makeInitial = (): ArisSessionStatusInternal => {
  const now = new Date().toISOString();
  return {
    status: "ready",
    activeTurnId: null,
    lastError: null,
    latestTurnId: null,
    latestTurnState: null,
    latestTurnStartedAt: null,
    latestTurnCompletedAt: null,
    sessionCreatedAt: now,
    updatedAt: now,
  };
};

export interface UseArisSessionStatusOptions {
  readonly threadId: ThreadId | null;
  readonly environmentId: EnvironmentId | null;
  readonly provider: string | null;
}

export interface UseArisSessionStatusResult {
  /** Synthesized `ThreadSession` shape, or null if not an Aris thread. */
  readonly session: ThreadSession | null;
  /** Synthesized `OrchestrationLatestTurn` shape, or null if no turn observed. */
  readonly latestTurn: OrchestrationLatestTurn | null;
}

const EMPTY_RESULT: UseArisSessionStatusResult = { session: null, latestTurn: null };

export function useArisSessionStatus(
  opts: UseArisSessionStatusOptions,
): UseArisSessionStatusResult {
  const { threadId, environmentId, provider } = opts;
  // DeepSeek shares ArisEventBus, so its session-status events flow
  // through the same channel. Both providers are gated on here.
  const enabled = (provider === "aris" || provider === "deepseek") && !!threadId && !!environmentId;

  const [state, setState] = useState<ArisSessionStatusInternal | null>(null);

  useEffect(() => {
    if (!enabled || !threadId || !environmentId) {
      setState(null);
      return;
    }

    const api = readEnvironmentApi(environmentId);
    if (!api) {
      return;
    }

    setState(makeInitial());

    // Slice 20 — diagnostic. Confirm subscription is active for this thread.
    // If the red stop button stays up and we never see "[useArisSessionStatus]
    // aris.turn.completed" for the active thread, the event isn't reaching
    // the React state — that's the disconnect. If we DO see it but `phase`
    // doesn't flip, the bug is in the consumer chain (derivePhase, prop wiring).
    console.log(
      `[useArisSessionStatus] subscribed threadId=${threadId} environmentId=${environmentId}`,
    );

    const unsubscribe = api.aris.subscribeEvents({ threadId }, (event) => {
      const updatedAt = event.createdAt;

      // Slice 20 — diagnostic. Lightweight per-event log scoped to lifecycle
      // events only (omit `aris.assistant.delta` and tool deltas to avoid
      // flooding). Keeps the console focused on the events that drive the
      // status pill / red-button state.
      if (
        event.type === "aris.session.started" ||
        event.type === "aris.session.ended" ||
        event.type === "aris.turn.started" ||
        event.type === "aris.turn.completed" ||
        event.type === "aris.turn.failed" ||
        event.type === "aris.turn.cancelled"
      ) {
        console.log(
          `[useArisSessionStatus] event=${event.type} threadId=${event.threadId} turnId=${event.turnId ?? "<none>"}`,
        );
      }

      setState((prev) => {
        const base = prev ?? makeInitial();

        switch (event.type) {
          case "aris.session.started":
            return { ...base, status: "ready", lastError: null, updatedAt };
          case "aris.session.ended":
            if (event.payload.reason === "error") {
              return {
                ...base,
                status: "error",
                activeTurnId: null,
                lastError: event.payload.errorMessage ?? base.lastError,
                updatedAt,
              };
            }
            return { ...base, status: "ready", activeTurnId: null, updatedAt };
          case "aris.turn.started": {
            const turnId = event.turnId ?? null;
            return {
              ...base,
              status: "running",
              activeTurnId: turnId,
              lastError: null,
              latestTurnId: turnId,
              latestTurnState: "running",
              latestTurnStartedAt: event.createdAt,
              latestTurnCompletedAt: null,
              updatedAt,
            };
          }
          case "aris.turn.completed": {
            const turnId = event.turnId ?? base.latestTurnId;
            return {
              ...base,
              status: "ready",
              activeTurnId: null,
              latestTurnId: turnId,
              latestTurnState: "completed",
              latestTurnCompletedAt: event.createdAt,
              updatedAt,
            };
          }
          case "aris.turn.failed": {
            const turnId = event.turnId ?? base.latestTurnId;
            return {
              ...base,
              status: "error",
              activeTurnId: null,
              latestTurnId: turnId,
              latestTurnState: "error",
              latestTurnCompletedAt: event.createdAt,
              lastError: event.payload.errorMessage,
              updatedAt,
            };
          }
          case "aris.turn.cancelled": {
            const turnId = event.turnId ?? base.latestTurnId;
            return {
              ...base,
              status: "ready",
              activeTurnId: null,
              latestTurnId: turnId,
              latestTurnState: "interrupted",
              latestTurnCompletedAt: event.createdAt,
              updatedAt,
            };
          }
          default:
            return base;
        }
      });
    });

    return () => {
      // Slice 20 — diagnostic. If we see this fire WHILE a turn is in
      // progress, the subscription is being torn down before
      // `aris.turn.completed` arrives — meaning the active threadId,
      // environmentId, or provider value churned. The event would still hit
      // the live PubSub but the new subscription would only receive events
      // ≥10s old via the bus replay buffer. Long turns (>10s) would lose
      // `aris.turn.completed`.
      console.log(
        `[useArisSessionStatus] unsubscribe threadId=${threadId} environmentId=${environmentId}`,
      );
      unsubscribe();
    };
  }, [enabled, environmentId, threadId]);

  return useMemo<UseArisSessionStatusResult>(() => {
    if (!enabled || !state) return EMPTY_RESULT;

    const orchestrationStatus: ThreadSession["orchestrationStatus"] =
      state.status === "running" ? "running" : state.status === "error" ? "error" : "ready";

    const session: ThreadSession = {
      provider: "aris",
      status: state.status,
      ...(state.activeTurnId !== null ? { activeTurnId: state.activeTurnId } : {}),
      createdAt: state.sessionCreatedAt,
      updatedAt: state.updatedAt,
      ...(state.lastError !== null ? { lastError: state.lastError } : {}),
      orchestrationStatus,
    };

    const latestTurn: OrchestrationLatestTurn | null =
      state.latestTurnId && state.latestTurnState && state.latestTurnStartedAt
        ? {
            turnId: state.latestTurnId,
            state: state.latestTurnState,
            requestedAt: state.latestTurnStartedAt,
            startedAt: state.latestTurnStartedAt,
            completedAt: state.latestTurnCompletedAt,
            assistantMessageId: null,
          }
        : null;

    return { session, latestTurn };
  }, [enabled, state]);
}
