/**
 * ArisEventBusLive — in-process bus with bounded per-thread event replay.
 *
 * Why a replay buffer:
 * `PubSub.unbounded` is fire-and-forget — subscribers that attach AFTER an
 * event is published miss it. The web client's WS RPC subscription
 * (`aris.subscribe.events`) attaches a fraction of a second after the user
 * sends a turn, but the first SSE frame from the upstream LLM (which fires
 * `aris.thread.persisted` on first conversation_id) and the early reasoning
 * deltas can arrive before the subscription is wired through React state.
 * Result on USER turn 1: thread doesn't appear in the sidebar until USER
 * turn 2 forces another wakeup, and the Reasoning/Thinking pane is blank.
 *
 * The fix: on every `publish`, mirror the event into a per-thread replay
 * buffer (bounded by `REPLAY_WINDOW_MS` and `REPLAY_MAX_PER_THREAD`). On
 * `streamForThread`, subscribe to live PubSub FIRST, snapshot the buffer +
 * sequence cutoff atomically, replay the buffered events for that thread
 * with `seq < liveSeqStart`, then concat with the live stream filtered to
 * `seq >= liveSeqStart`. Events delivered through the replay path cannot
 * also slip through the live path — the sequence cutoff guarantees no
 * duplicate delivery — and events published between subscription and
 * snapshot are retained because the subscriber is already attached.
 *
 * State is held in a single `Ref<{ nextSeq, buffer }>` so seq-assignment,
 * buffer-write and PubSub-publish reads stay consistent. `streamAll`
 * remains unfiltered and untranslated for the WS push channel and the
 * session registry — both attach at server boot, well before any turn.
 *
 * @module ArisEventBusLive
 */
import { Effect, Layer, PubSub, Ref, Stream } from "effect";

import type { ArisEvent, ThreadId } from "@t3tools/contracts";

import { ArisEventBus, type ArisEventBusShape } from "../Services/ArisEventBus.ts";

/**
 * Replay window covers the worst-case gap between `aris.subscribe.events`
 * being dispatched on the WS and the subscriber actually pulling from the
 * Stream — WS round-trip + RPC handler + React effect commit. 10s is
 * generous; the actual gap is sub-second on healthy connections.
 */
const REPLAY_WINDOW_MS = 10_000;

/**
 * Hard cap on buffered events per thread. Defends against pathological
 * bursts (e.g. tool-call streams emitting hundreds of deltas) while
 * leaving plenty of headroom for normal turn replay.
 */
const REPLAY_MAX_PER_THREAD = 256;

interface BufferedEvent {
  readonly event: ArisEvent;
  readonly seq: number;
  readonly ts: number;
}

interface TaggedEvent {
  readonly event: ArisEvent;
  readonly seq: number;
}

interface BusState {
  readonly nextSeq: number;
  readonly buffer: ReadonlyMap<ThreadId, ReadonlyArray<BufferedEvent>>;
}

const pruneEntries = (
  entries: ReadonlyArray<BufferedEvent>,
  now: number,
): ReadonlyArray<BufferedEvent> => {
  const cutoffTs = now - REPLAY_WINDOW_MS;
  let firstFreshIdx = 0;
  // entries are append-ordered, so timestamps are monotonic — drop the
  // expired prefix in one slice rather than filtering the whole array.
  while (firstFreshIdx < entries.length && entries[firstFreshIdx]!.ts < cutoffTs) {
    firstFreshIdx += 1;
  }
  const fresh = firstFreshIdx === 0 ? entries : entries.slice(firstFreshIdx);
  if (fresh.length <= REPLAY_MAX_PER_THREAD) {
    return fresh;
  }
  return fresh.slice(fresh.length - REPLAY_MAX_PER_THREAD);
};

export const ArisEventBusLive = Layer.effect(
  ArisEventBus,
  Effect.gen(function* () {
    const pubsub = yield* Effect.acquireRelease(PubSub.unbounded<TaggedEvent>(), (ps) =>
      PubSub.shutdown(ps),
    );
    const stateRef = yield* Ref.make<BusState>({
      nextSeq: 1,
      buffer: new Map<ThreadId, ReadonlyArray<BufferedEvent>>(),
    });

    const publish: ArisEventBusShape["publish"] = (event) =>
      Effect.gen(function* () {
        const tagged = yield* Ref.modify(stateRef, (state) => {
          const seq = state.nextSeq;
          const now = Date.now();
          const existing = state.buffer.get(event.threadId) ?? [];
          const appended = pruneEntries([...existing, { event, seq, ts: now }], now);
          const nextBuffer = new Map(state.buffer);
          nextBuffer.set(event.threadId, appended);
          const next: BusState = { nextSeq: seq + 1, buffer: nextBuffer };
          const taggedEvent: TaggedEvent = { event, seq };
          return [taggedEvent, next];
        });
        yield* PubSub.publish(pubsub, tagged);
      }).pipe(Effect.asVoid);

    const streamAll: ArisEventBusShape["streamAll"] = () =>
      Stream.fromPubSub(pubsub).pipe(Stream.map((tagged) => tagged.event));

    const streamForThread: ArisEventBusShape["streamForThread"] = (threadId: ThreadId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe BEFORE snapshotting state. Any event published after
          // this point lands in the subscription queue, so the cutoff +
          // live-filter pair is sufficient to deduplicate replay vs live.
          const subscription = yield* PubSub.subscribe(pubsub);
          const state = yield* Ref.get(stateRef);
          const liveSeqStart = state.nextSeq;
          const now = Date.now();
          const replayEntries = pruneEntries(state.buffer.get(threadId) ?? [], now).filter(
            (entry) => entry.seq < liveSeqStart,
          );
          const replayStream = Stream.fromIterable(replayEntries.map((entry) => entry.event));
          const liveStream = Stream.fromSubscription(subscription).pipe(
            Stream.filter(
              (tagged) => tagged.event.threadId === threadId && tagged.seq >= liveSeqStart,
            ),
            Stream.map((tagged) => tagged.event),
          );
          return Stream.concat(replayStream, liveStream);
        }),
      );

    return {
      publish,
      streamAll,
      streamForThread,
    } satisfies ArisEventBusShape;
  }),
);
