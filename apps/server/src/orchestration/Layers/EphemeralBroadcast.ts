import { Effect, Layer, PubSub, Stream } from "effect";
import type { EphemeralReasoningStreamEvent, ThreadId, TurnId } from "@t3tools/contracts";

import {
  EphemeralBroadcast,
  type EphemeralBroadcastShape,
} from "../Services/EphemeralBroadcast.ts";

export const EphemeralBroadcastLive = Layer.effect(
  EphemeralBroadcast,
  Effect.gen(function* () {
    const pubsub = yield* Effect.acquireRelease(
      PubSub.unbounded<EphemeralReasoningStreamEvent>(),
      (ps) => PubSub.shutdown(ps),
    );

    const publishReasoningDelta: EphemeralBroadcastShape["publishReasoningDelta"] = (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly delta: string;
    }) =>
      PubSub.publish(pubsub, {
        kind: "delta" as const,
        payload: {
          version: 1 as const,
          threadId: input.threadId,
          turnId: input.turnId,
          delta: input.delta,
          emittedAt: new Date().toISOString(),
        },
      }).pipe(Effect.asVoid);

    const publishContentDelta: EphemeralBroadcastShape["publishContentDelta"] = (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
      readonly delta: string;
    }) =>
      PubSub.publish(pubsub, {
        kind: "content-delta" as const,
        payload: {
          version: 1 as const,
          threadId: input.threadId,
          turnId: input.turnId,
          delta: input.delta,
          emittedAt: new Date().toISOString(),
        },
      }).pipe(Effect.asVoid);

    const publishTurnEnded: EphemeralBroadcastShape["publishTurnEnded"] = (input: {
      readonly threadId: ThreadId;
      readonly turnId: TurnId | null;
    }) =>
      PubSub.publish(pubsub, {
        kind: "turn-ended" as const,
        threadId: input.threadId,
        turnId: input.turnId,
      }).pipe(Effect.asVoid);

    const streamForThread: EphemeralBroadcastShape["streamForThread"] = (threadId: ThreadId) =>
      Stream.fromPubSub(pubsub).pipe(
        Stream.filter((event) => {
          if (event.kind === "delta" || event.kind === "content-delta") {
            return event.payload.threadId === threadId;
          }
          return event.threadId === threadId;
        }),
      );

    return {
      publishReasoningDelta,
      publishContentDelta,
      publishTurnEnded,
      streamForThread,
    } satisfies EphemeralBroadcastShape;
  }),
);
