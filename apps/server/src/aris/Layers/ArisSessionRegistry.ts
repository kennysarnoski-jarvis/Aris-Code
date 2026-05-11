import { Effect, Layer, Ref, Stream } from "effect";

import type { ArisEvent, RuntimeMode, ThreadId } from "@t3tools/contracts";

import { ArisEventBus } from "../Services/ArisEventBus.ts";
import {
  ArisSessionRegistry,
  type ArisSessionRegistryShape,
  type ArisSessionSnapshot,
} from "../Services/ArisSessionRegistry.ts";

const initialSnapshot = (
  threadId: ThreadId,
  runtimeMode: RuntimeMode | null,
  updatedAt: string,
): ArisSessionSnapshot => ({
  threadId,
  status: "idle",
  activeTurnId: null,
  lastError: null,
  runtimeMode,
  updatedAt,
});

/**
 * Pure reducer — `(prior, event) → next`. Keep this side-effect free so it
 * can be tested in isolation without setting up a PubSub.
 *
 * Status transitions:
 *   - `aris.session.started`           → ready, clear lastError
 *   - `aris.session.ended` (error)     → error, clear activeTurnId, set lastError
 *   - `aris.session.ended` (other)     → idle,  clear activeTurnId
 *   - `aris.turn.started`              → running, set activeTurnId + runtimeMode
 *   - `aris.turn.completed`            → ready, clear activeTurnId
 *   - `aris.turn.failed`               → error, clear activeTurnId, set lastError
 *   - `aris.turn.cancelled`            → ready, clear activeTurnId
 *   - `aris.error` (recoverable=false) → error, set lastError
 *   - all other event types            → no status change, just bumps updatedAt
 */
export const applyArisEvent = (
  prior: ArisSessionSnapshot | undefined,
  event: ArisEvent,
): ArisSessionSnapshot => {
  const updatedAt = event.createdAt;
  const base: ArisSessionSnapshot = prior ?? initialSnapshot(event.threadId, null, updatedAt);

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
      return { ...base, status: "idle", activeTurnId: null, updatedAt };
    case "aris.turn.started":
      return {
        ...base,
        status: "running",
        activeTurnId: event.turnId ?? null,
        runtimeMode: event.payload.runtimeMode,
        lastError: null,
        updatedAt,
      };
    case "aris.turn.completed":
      return { ...base, status: "ready", activeTurnId: null, updatedAt };
    case "aris.turn.failed":
      return {
        ...base,
        status: "error",
        activeTurnId: null,
        lastError: event.payload.errorMessage,
        updatedAt,
      };
    case "aris.turn.cancelled":
      return { ...base, status: "ready", activeTurnId: null, updatedAt };
    case "aris.error":
      if (!event.payload.recoverable) {
        return { ...base, status: "error", lastError: event.payload.message, updatedAt };
      }
      return { ...base, updatedAt };
    default:
      return { ...base, updatedAt };
  }
};

export const ArisSessionRegistryLive = Layer.effect(
  ArisSessionRegistry,
  Effect.gen(function* () {
    const bus = yield* ArisEventBus;
    const stateRef = yield* Ref.make<ReadonlyMap<ThreadId, ArisSessionSnapshot>>(new Map());

    yield* Effect.forkScoped(
      Stream.runForEach(bus.streamAll(), (event) =>
        Ref.update(stateRef, (current) => {
          const next = new Map(current);
          next.set(event.threadId, applyArisEvent(current.get(event.threadId), event));
          return next;
        }),
      ),
    );

    const getSnapshot: ArisSessionRegistryShape["getSnapshot"] = (threadId) =>
      Ref.get(stateRef).pipe(Effect.map((map) => map.get(threadId) ?? null));

    const listSnapshots: ArisSessionRegistryShape["listSnapshots"] = () =>
      Ref.get(stateRef).pipe(Effect.map((map) => Array.from(map.values())));

    return {
      getSnapshot,
      listSnapshots,
    } satisfies ArisSessionRegistryShape;
  }),
);
