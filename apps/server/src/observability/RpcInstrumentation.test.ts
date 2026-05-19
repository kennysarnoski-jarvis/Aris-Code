import { assert, describe, it } from "@effect/vitest";
import { afterEach, expect, it as vitestIt } from "vitest";
import { Cause, Effect, Exit, Metric, Stream } from "effect";

import {
  __resetRpcTokenBucketForTests,
  observeRpcEffect,
  observeRpcStream,
  observeRpcStreamEffect,
  RPC_TOKEN_BUCKET_CAPACITY,
  RPC_TOKEN_BUCKET_REFILL_PER_SEC,
  RpcRateLimitError,
  tryAcquireRpcToken,
} from "./RpcInstrumentation.ts";

const hasMetricSnapshot = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.some(
    (snapshot) =>
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

describe("RpcInstrumentation", () => {
  it.effect("records success metrics for unary RPC handlers", () =>
    Effect.gen(function* () {
      yield* observeRpcEffect("rpc.instrumentation.success", Effect.succeed("ok"), {
        "rpc.aggregate": "test",
      }).pipe(Effect.withSpan("rpc.instrumentation.success.span"));

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_requests_total", {
          method: "rpc.instrumentation.success",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_request_duration", {
          method: "rpc.instrumentation.success",
        }),
        true,
      );
    }),
  );

  it.effect("records failure outcomes for unary RPC handlers", () =>
    Effect.gen(function* () {
      yield* Effect.exit(
        observeRpcEffect("rpc.instrumentation.failure", Effect.fail("boom"), {
          "rpc.aggregate": "test",
        }).pipe(Effect.withSpan("rpc.instrumentation.failure.span")),
      );

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_requests_total", {
          method: "rpc.instrumentation.failure",
          outcome: "failure",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_request_duration", {
          method: "rpc.instrumentation.failure",
        }),
        true,
      );
    }),
  );

  it.effect("records subscription activation metrics for stream RPC handlers", () =>
    Effect.gen(function* () {
      const events = yield* Stream.runCollect(
        observeRpcStreamEffect(
          "rpc.instrumentation.stream",
          Effect.succeed(Stream.make("a", "b")),
          { "rpc.aggregate": "test" },
        ).pipe(Stream.withSpan("rpc.instrumentation.stream.span")),
      );

      assert.deepStrictEqual(Array.from(events), ["a", "b"]);

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_requests_total", {
          method: "rpc.instrumentation.stream",
          outcome: "success",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_request_duration", {
          method: "rpc.instrumentation.stream",
        }),
        true,
      );
    }),
  );

  it.effect("records failure outcomes for direct stream RPC handlers during consumption", () =>
    Effect.gen(function* () {
      const exit = yield* Stream.runCollect(
        observeRpcStream(
          "rpc.instrumentation.stream.failure",
          Stream.make("a").pipe(Stream.concat(Stream.fail("boom"))),
          { "rpc.aggregate": "test" },
        ).pipe(Stream.withSpan("rpc.instrumentation.stream.failure.span")),
      ).pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_requests_total", {
          method: "rpc.instrumentation.stream.failure",
          outcome: "failure",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_request_duration", {
          method: "rpc.instrumentation.stream.failure",
        }),
        true,
      );
    }),
  );

  it.effect("records failure outcomes when a stream RPC effect produces a failing stream", () =>
    Effect.gen(function* () {
      const exit = yield* Stream.runCollect(
        observeRpcStreamEffect(
          "rpc.instrumentation.stream.effect.failure",
          Effect.succeed(Stream.fail("boom")),
          { "rpc.aggregate": "test" },
        ).pipe(Stream.withSpan("rpc.instrumentation.stream.effect.failure.span")),
      ).pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);

      const snapshots = yield* Metric.snapshot;

      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_requests_total", {
          method: "rpc.instrumentation.stream.effect.failure",
          outcome: "failure",
        }),
        true,
      );
      assert.equal(
        hasMetricSnapshot(snapshots, "t3_rpc_request_duration", {
          method: "rpc.instrumentation.stream.effect.failure",
        }),
        true,
      );
    }),
  );
});

/**
 * Slice Q / M4-2 — RPC rate-limit (token bucket) tests.
 *
 * Pins the gate at the entry to both `observeRpcEffect` and
 * `observeRpcStreamEffect`. If a future refactor moves the rate
 * limit elsewhere or removes the gate, these trip immediately.
 *
 *   - Bucket capacity and refill rate values are pinned directly so
 *     a sneaky bump (e.g. 100 → 10000) trips the constant test.
 *   - Exhaust-and-reject is exercised at the unit level
 *     (`tryAcquireRpcToken`) and at the integration level
 *     (`observeRpcEffect` denies the 101st rapid-fire call).
 *   - Refill is exercised via a small wait that fakes "some time
 *     has passed" — after 100ms with 100/sec refill we expect ~10
 *     tokens back.
 */
describe("Slice Q — M4-2: RPC rate-limit (token bucket)", () => {
  afterEach(() => {
    __resetRpcTokenBucketForTests();
  });

  vitestIt("bucket capacity is 100 (pinned)", () => {
    expect(RPC_TOKEN_BUCKET_CAPACITY).toBe(100);
  });

  vitestIt("bucket refill rate is 100/sec (pinned)", () => {
    expect(RPC_TOKEN_BUCKET_REFILL_PER_SEC).toBe(100);
  });

  vitestIt("acquires up to capacity, then rejects", () => {
    // Exhaust the bucket. Capacity acquires must succeed.
    for (let i = 0; i < RPC_TOKEN_BUCKET_CAPACITY; i += 1) {
      expect(tryAcquireRpcToken()).toBe(true);
    }
    // The next acquire — immediately, before any refill elapses —
    // must fail. This is the load-bearing assertion: without it,
    // a renderer-bug infinite loop would burn server CPU on every
    // call's dispatch + tracing + metric record + serialization
    // even when the response is "rate limited."
    expect(tryAcquireRpcToken()).toBe(false);
  });

  vitestIt("refills after time elapses", async () => {
    // Drain to empty.
    for (let i = 0; i < RPC_TOKEN_BUCKET_CAPACITY; i += 1) {
      tryAcquireRpcToken();
    }
    expect(tryAcquireRpcToken()).toBe(false);

    // Wait ~50ms — at 100 tokens/sec that's ~5 new tokens. Wait
    // 60ms to leave headroom for clock jitter on slow CI.
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Must be able to acquire again.
    expect(tryAcquireRpcToken()).toBe(true);
  });

  it.effect("observeRpcEffect dies with RpcRateLimitError when bucket is empty", () =>
    Effect.gen(function* () {
      // Drain the bucket so the next call hits the gate.
      for (let i = 0; i < RPC_TOKEN_BUCKET_CAPACITY; i += 1) {
        tryAcquireRpcToken();
      }

      const exit = yield* Effect.exit(
        observeRpcEffect("rpc.instrumentation.rate-limit", Effect.succeed("ok"), {
          "rpc.aggregate": "test",
        }),
      );

      // Die path: Cause is a Die, not a Fail. The defect carries
      // the RpcRateLimitError instance.
      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        // Effect 4: walk cause.reasons and pick Die entries. The
        // gate calls Effect.die(new RpcRateLimitError(...)) so we
        // expect exactly one Die whose defect is the instance.
        const dieReasons = exit.cause.reasons.filter(Cause.isDieReason);
        assert.equal(dieReasons.length >= 1, true);
        assert.equal(dieReasons[0]!.defect instanceof RpcRateLimitError, true);
      }
    }),
  );

  it.effect("observeRpcEffect succeeds when bucket has tokens", () =>
    Effect.gen(function* () {
      // Fresh bucket from afterEach reset — first call must succeed.
      const value = yield* observeRpcEffect(
        "rpc.instrumentation.rate-limit.allowed",
        Effect.succeed("ok"),
        { "rpc.aggregate": "test" },
      );
      assert.equal(value, "ok");
    }),
  );

  it.effect("observeRpcStreamEffect dies with RpcRateLimitError when bucket is empty", () =>
    Effect.gen(function* () {
      for (let i = 0; i < RPC_TOKEN_BUCKET_CAPACITY; i += 1) {
        tryAcquireRpcToken();
      }

      const exit = yield* Stream.runCollect(
        observeRpcStreamEffect(
          "rpc.instrumentation.rate-limit.stream",
          Effect.succeed(Stream.make("a", "b")),
          { "rpc.aggregate": "test" },
        ),
      ).pipe(Effect.exit);

      assert.equal(Exit.isFailure(exit), true);
      if (Exit.isFailure(exit)) {
        // Effect 4: walk cause.reasons and pick Die entries. The
        // gate calls Effect.die(new RpcRateLimitError(...)) so we
        // expect exactly one Die whose defect is the instance.
        const dieReasons = exit.cause.reasons.filter(Cause.isDieReason);
        assert.equal(dieReasons.length >= 1, true);
        assert.equal(dieReasons[0]!.defect instanceof RpcRateLimitError, true);
      }
    }),
  );
});
