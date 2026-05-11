import { Schema } from "effect";
import * as Rpc from "effect/unstable/rpc/Rpc";

import { ThreadId, TurnId } from "./baseSchemas";

/**
 * Ephemeral WebSocket methods — side-channel streams that are NOT persisted
 * in the orchestration event store. Use for high-churn transient UI signals
 * (e.g. reasoning tokens, content deltas for providers that own their own
 * persistence layer) where replay/durability is not desired.
 */
export const EPHEMERAL_WS_METHODS = {
  subscribeEphemeralReasoning: "ephemeral.subscribeReasoning",
} as const;

/**
 * A single reasoning-token delta for a specific thread/turn. Emitted live,
 * never stored. Consumers should render immediately and drop old values.
 */
export const EphemeralReasoningDelta = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  delta: Schema.String,
  emittedAt: Schema.String,
});
export type EphemeralReasoningDelta = typeof EphemeralReasoningDelta.Type;

const EphemeralReasoningDeltaEvent = Schema.Struct({
  kind: Schema.Literal("delta"),
  payload: EphemeralReasoningDelta,
});
export type EphemeralReasoningDeltaEvent = typeof EphemeralReasoningDeltaEvent.Type;

/**
 * A single answer-content-token delta for a specific thread/turn. Used by
 * providers (notably Aris) that own their own persistence layer and do not
 * project content into state.sqlite. Web clients subscribe to this to render
 * in-flight assistant output; on thread reload, history is fetched from the
 * provider's own store (e.g. aris_memory.db), not replayed from these events.
 */
export const EphemeralContentDelta = Schema.Struct({
  version: Schema.Literal(1),
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
  delta: Schema.String,
  emittedAt: Schema.String,
});
export type EphemeralContentDelta = typeof EphemeralContentDelta.Type;

const EphemeralContentDeltaEvent = Schema.Struct({
  kind: Schema.Literal("content-delta"),
  payload: EphemeralContentDelta,
});
export type EphemeralContentDeltaEvent = typeof EphemeralContentDeltaEvent.Type;

const EphemeralReasoningTurnEndedEvent = Schema.Struct({
  kind: Schema.Literal("turn-ended"),
  threadId: ThreadId,
  turnId: Schema.NullOr(TurnId),
});
export type EphemeralReasoningTurnEndedEvent = typeof EphemeralReasoningTurnEndedEvent.Type;

export const EphemeralReasoningStreamEvent = Schema.Union([
  EphemeralReasoningDeltaEvent,
  EphemeralContentDeltaEvent,
  EphemeralReasoningTurnEndedEvent,
]);
export type EphemeralReasoningStreamEvent = typeof EphemeralReasoningStreamEvent.Type;

export const EphemeralSubscribeReasoningInput = Schema.Struct({
  threadId: ThreadId,
});
export type EphemeralSubscribeReasoningInput = typeof EphemeralSubscribeReasoningInput.Type;

export const WsSubscribeEphemeralReasoningRpc = Rpc.make(
  EPHEMERAL_WS_METHODS.subscribeEphemeralReasoning,
  {
    payload: EphemeralSubscribeReasoningInput,
    success: EphemeralReasoningStreamEvent,
    stream: true,
  },
);
