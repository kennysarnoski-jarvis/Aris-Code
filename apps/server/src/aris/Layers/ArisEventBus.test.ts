import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Ref, Stream } from "effect";
import { describe } from "vitest";

import { type ArisEvent, ThreadId } from "@t3tools/contracts";

import { ArisEventBus } from "../Services/ArisEventBus.ts";
import { ArisEventBusLive } from "./ArisEventBus.ts";

// Wall-clock sleep — bypasses TestClock so the forked subscriber has real
// time to attach to the PubSub before we publish. `Effect.sleep(Duration)`
// is TestClock-aware under `it.effect` and returns instantly, which loses
// the subscription race deterministically. Matches the existing codebase
// pattern (see provider/Layers/ProviderService.test.ts).
const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const threadA = ThreadId.make("aris-test-thread-a");
const threadB = ThreadId.make("aris-test-thread-b");

const sessionStartedEvent = (threadId: ThreadId): ArisEvent => ({
  type: "aris.session.started",
  threadId,
  createdAt: "2026-04-30T12:00:00.000Z",
  payload: {},
});

describe("ArisEventBusLive", () => {
  it.effect("delivers published events to a thread-scoped subscriber", () =>
    Effect.gen(function* () {
      const bus = yield* ArisEventBus;
      const receivedRef = yield* Ref.make<Array<ArisEvent>>([]);

      const consumer = yield* Stream.take(bus.streamForThread(threadA), 1).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );

      // Give the subscriber a moment to attach to the PubSub before we publish.
      // Without this small gap the publish can race ahead of the subscription.
      yield* sleep(50);
      yield* bus.publish(sessionStartedEvent(threadA));

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepStrictEqual(received, [sessionStartedEvent(threadA)]);
    }).pipe(Effect.provide(ArisEventBusLive)),
  );

  it.effect("filters out events scoped to other threads", () =>
    Effect.gen(function* () {
      const bus = yield* ArisEventBus;
      const receivedRef = yield* Ref.make<Array<ArisEvent>>([]);

      const consumer = yield* Stream.take(bus.streamForThread(threadA), 1).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );

      yield* sleep(50);
      // Publish for threadB first — should be filtered out by streamForThread —
      // then for threadA. Only the threadA event should reach the consumer.
      yield* bus.publish(sessionStartedEvent(threadB));
      yield* bus.publish(sessionStartedEvent(threadA));

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepStrictEqual(received, [sessionStartedEvent(threadA)]);
    }).pipe(Effect.provide(ArisEventBusLive)),
  );

  it.effect("delivers every published event to streamAll regardless of thread", () =>
    Effect.gen(function* () {
      const bus = yield* ArisEventBus;
      const receivedRef = yield* Ref.make<Array<ArisEvent>>([]);

      const consumer = yield* Stream.take(bus.streamAll(), 2).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );

      yield* sleep(50);
      yield* bus.publish(sessionStartedEvent(threadA));
      yield* bus.publish(sessionStartedEvent(threadB));

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepStrictEqual(received, [
        sessionStartedEvent(threadA),
        sessionStartedEvent(threadB),
      ]);
    }).pipe(Effect.provide(ArisEventBusLive)),
  );

  // The bug we're fixing: web client's `aris.subscribe.events` attaches a
  // beat after `aris.thread.persisted` is fired by the SSE first-frame on
  // brand-new threads. Without replay, USER turn 1 misses the event and
  // the sidebar doesn't refresh until turn 2 forces another wakeup.
  it.effect("replays recent events to a subscriber that attaches after publish", () =>
    Effect.gen(function* () {
      const bus = yield* ArisEventBus;
      const receivedRef = yield* Ref.make<Array<ArisEvent>>([]);

      // Publish FIRST — no subscriber attached yet.
      yield* bus.publish(sessionStartedEvent(threadA));

      // Subscriber attaches AFTER the publish. Replay buffer should
      // surface the missed event.
      const consumer = yield* Stream.take(bus.streamForThread(threadA), 1).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepStrictEqual(received, [sessionStartedEvent(threadA)]);
    }).pipe(Effect.provide(ArisEventBusLive)),
  );

  // Replay must still scope by threadId — a late subscriber for thread A
  // should not see thread B's history.
  it.effect("scopes the replay buffer by threadId", () =>
    Effect.gen(function* () {
      const bus = yield* ArisEventBus;
      const receivedRef = yield* Ref.make<Array<ArisEvent>>([]);

      yield* bus.publish(sessionStartedEvent(threadB));
      yield* bus.publish(sessionStartedEvent(threadA));

      const consumer = yield* Stream.take(bus.streamForThread(threadA), 1).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepStrictEqual(received, [sessionStartedEvent(threadA)]);
    }).pipe(Effect.provide(ArisEventBusLive)),
  );

  // No double delivery across the replay/live boundary. Subscriber sees
  // each event exactly once whether it comes from the buffer or live.
  it.effect("delivers each event exactly once across the replay/live boundary", () =>
    Effect.gen(function* () {
      const bus = yield* ArisEventBus;
      const receivedRef = yield* Ref.make<Array<ArisEvent>>([]);

      const eventA1: ArisEvent = {
        type: "aris.session.started",
        threadId: threadA,
        createdAt: "2026-04-30T12:00:00.000Z",
        payload: {},
      };
      const eventA2: ArisEvent = {
        type: "aris.session.started",
        threadId: threadA,
        createdAt: "2026-04-30T12:00:01.000Z",
        payload: {},
      };

      // Publish one before the subscriber attaches (lands in replay buffer).
      yield* bus.publish(eventA1);

      const consumer = yield* Stream.take(bus.streamForThread(threadA), 2).pipe(
        Stream.runForEach((event) => Ref.update(receivedRef, (current) => [...current, event])),
        Effect.forkChild,
      );

      // Give the subscriber a moment to attach before the live publish so
      // we exercise both paths in one consumer.
      yield* sleep(50);
      yield* bus.publish(eventA2);

      yield* Fiber.join(consumer);
      const received = yield* Ref.get(receivedRef);
      assert.deepStrictEqual(received, [eventA1, eventA2]);
    }).pipe(Effect.provide(ArisEventBusLive)),
  );
});
