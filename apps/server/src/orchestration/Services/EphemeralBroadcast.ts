/**
 * EphemeralBroadcast - Side-channel pub/sub for non-persisted, transient
 * streams pushed from the server to subscribed web clients.
 *
 * Reasoning tokens, rolling "thinking" UI signals, and similar high-churn
 * diagnostic data flow through this service instead of the orchestration
 * event store so nothing is written to disk or kept around after emission.
 *
 * @module EphemeralBroadcast
 */
import { Context } from "effect";
import type { Effect, Stream } from "effect";
import type { EphemeralReasoningStreamEvent, ThreadId, TurnId } from "@t3tools/contracts";

export interface EphemeralBroadcastShape {
  readonly publishReasoningDelta: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly delta: string;
  }) => Effect.Effect<void>;
  readonly publishContentDelta: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
    readonly delta: string;
  }) => Effect.Effect<void>;
  readonly publishTurnEnded: (input: {
    readonly threadId: ThreadId;
    readonly turnId: TurnId | null;
  }) => Effect.Effect<void>;
  readonly streamForThread: (threadId: ThreadId) => Stream.Stream<EphemeralReasoningStreamEvent>;
}

export class EphemeralBroadcast extends Context.Service<
  EphemeralBroadcast,
  EphemeralBroadcastShape
>()("t3/orchestration/Services/EphemeralBroadcast") {}
