/**
 * ArisEventBus — internal apps/server pub/sub for `ArisEvent` values.
 *
 * The single seam between `ArisAdapter` (the sole producer) and the
 * consumers (the WS push channel that fans events out to the browser,
 * and `ArisSessionRegistry` which folds events into derived per-thread
 * status). The bus lives in-process; it does not write to disk and is
 * empty after a server restart, which is correct — Aris turns are HTTP
 * streams that die with the process anyway.
 *
 * Cut C of the Aris architecture: Aris bypasses the orchestration engine
 * entirely. This bus replaces the OrchestrationEventStore + projection
 * pipeline path for Aris-provider events.
 *
 * @module ArisEventBus
 */
import { Context } from "effect";
import type { Effect, Stream } from "effect";

import type { ArisEvent, ThreadId } from "@t3tools/contracts";

export interface ArisEventBusShape {
  /** Publish a single Aris event to all subscribers. Fire-and-forget. */
  readonly publish: (event: ArisEvent) => Effect.Effect<void>;
  /** Subscribe to every event on the bus, regardless of thread. */
  readonly streamAll: () => Stream.Stream<ArisEvent>;
  /** Subscribe to events scoped to a single thread. */
  readonly streamForThread: (threadId: ThreadId) => Stream.Stream<ArisEvent>;
}

export class ArisEventBus extends Context.Service<ArisEventBus, ArisEventBusShape>()(
  "t3/aris/Services/ArisEventBus",
) {}
