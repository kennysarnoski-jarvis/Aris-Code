import { Duration, Effect, Exit, Metric, Stream } from "effect";

import { outcomeFromExit } from "./Attributes.ts";
import { metricAttributes, rpcRequestDuration, rpcRequestsTotal, withMetrics } from "./Metrics.ts";

// ──────────────────────────────────────────────────────────────────────
// Slice Q / M4-2 — RPC rate limit (token bucket).
//
// Every WS RPC method routes through `observeRpcEffect` or
// `observeRpcStreamEffect`, so the choke point sits here: a single
// gate that rejects calls beyond the configured rate.
//
// Token-bucket parameters: 100 tokens, refilled at 100/sec. That's
// well above any legitimate UI burst (a heavy app tab opening might
// fan out ~20 RPC reads in parallel) but tight enough to stop a
// renderer infinite loop or a compromised renderer from burning
// server CPU on dispatch + tracing + serialization. Refill is lazy
// (computed from elapsed wall time on each acquire) so there's no
// background timer churn.
//
// Single-owner Electron is the current deployment model
// (`project_aris_deployment_model`), so a global bucket is enough.
// When Slice K introduces multi-owner pairing, this becomes the
// hook point for per-session quotas — the gate already exists, just
// swap the global state for a Map keyed by session id.
// ──────────────────────────────────────────────────────────────────────
export const RPC_TOKEN_BUCKET_CAPACITY = 100;
export const RPC_TOKEN_BUCKET_REFILL_PER_SEC = 100;
let availableTokens = RPC_TOKEN_BUCKET_CAPACITY;
let lastRefillTimeMs = Date.now();

/**
 * Test-only hook to reset the module-level bucket so individual
 * cases don't leak token state into one another. Production code
 * must NEVER call this — exhausting the bucket is part of the
 * defense, not a knob.
 */
export function __resetRpcTokenBucketForTests(): void {
  availableTokens = RPC_TOKEN_BUCKET_CAPACITY;
  lastRefillTimeMs = Date.now();
}

function refillRpcTokens(now: number): void {
  const elapsedSec = (now - lastRefillTimeMs) / 1000;
  if (elapsedSec <= 0) return;
  const newTokens = elapsedSec * RPC_TOKEN_BUCKET_REFILL_PER_SEC;
  availableTokens = Math.min(RPC_TOKEN_BUCKET_CAPACITY, availableTokens + newTokens);
  lastRefillTimeMs = now;
}

/**
 * Attempt to consume one token from the RPC bucket. Returns `true`
 * if a token was available (call may proceed), `false` if the
 * bucket is empty (call must be rejected). Lazy refill — wall-clock
 * elapsed time is converted to new tokens on every call, so there's
 * no separate timer to drift.
 */
export function tryAcquireRpcToken(): boolean {
  refillRpcTokens(Date.now());
  if (availableTokens >= 1) {
    availableTokens -= 1;
    return true;
  }
  return false;
}

/**
 * Thrown via `Effect.die` when the RPC bucket is exhausted. Plain
 * `Error` (not a Schema.TaggedErrorClass) because the rate-limit
 * gate is internal — methods don't declare it in their error union.
 * The Cause flows up through the RPC framework as a defect and the
 * client sees a generic "internal error" on the wire, which is the
 * right UX for "you're being rate-limited" (we don't want to give a
 * compromised renderer a clean 429 it can retry against).
 */
export class RpcRateLimitError extends Error {
  override readonly name = "RpcRateLimitError";
  constructor() {
    super(`RPC rate limit exceeded (bucket capacity ${RPC_TOKEN_BUCKET_CAPACITY})`);
  }
}

const annotateRpcSpan = (
  method: string,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Effect.Effect<void, never, never> =>
  Effect.annotateCurrentSpan({
    "rpc.method": method,
    ...traceAttributes,
  });

const recordRpcStreamMetrics = <E>(
  method: string,
  startedAt: number,
  exit: Exit.Exit<unknown, E>,
): Effect.Effect<void, never, never> =>
  Effect.gen(function* () {
    yield* Metric.update(
      Metric.withAttributes(rpcRequestDuration, metricAttributes({ method })),
      Duration.millis(Math.max(0, Date.now() - startedAt)),
    );
    yield* Metric.update(
      Metric.withAttributes(
        rpcRequestsTotal,
        metricAttributes({
          method,
          outcome: outcomeFromExit(exit),
        }),
      ),
      1,
    );
  });

export const observeRpcEffect = <A, E, R>(
  method: string,
  effect: Effect.Effect<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    // Slice Q / M4-2 — rate-limit gate. See header for rationale.
    // Bucket is global because Aris Code is single-owner Electron;
    // swap for per-session when Slice K introduces multi-owner.
    if (!tryAcquireRpcToken()) {
      return yield* Effect.die(new RpcRateLimitError());
    }
    yield* annotateRpcSpan(method, traceAttributes);

    return yield* effect.pipe(
      withMetrics({
        counter: rpcRequestsTotal,
        timer: rpcRequestDuration,
        attributes: {
          method,
        },
      }),
    );
  });

export const observeRpcStream = <A, E, R>(
  method: string,
  stream: Stream.Stream<A, E, R>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Stream.Stream<A, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      yield* annotateRpcSpan(method, traceAttributes);
      const startedAt = Date.now();
      return stream.pipe(Stream.onExit((exit) => recordRpcStreamMetrics(method, startedAt, exit)));
    }),
  );

export const observeRpcStreamEffect = <A, StreamError, StreamContext, EffectError, EffectContext>(
  method: string,
  effect: Effect.Effect<Stream.Stream<A, StreamError, StreamContext>, EffectError, EffectContext>,
  traceAttributes?: Readonly<Record<string, unknown>>,
): Stream.Stream<A, StreamError | EffectError, StreamContext | EffectContext> =>
  Stream.unwrap(
    Effect.gen(function* () {
      // Slice Q / M4-2 — same rate-limit gate as observeRpcEffect.
      // The stream-open call consumes one token; the stream itself
      // is then unmetered (one open = one token, regardless of how
      // many events flow). Defense-in-depth against renderer bugs
      // that re-subscribe in a hot loop.
      if (!tryAcquireRpcToken()) {
        return yield* Effect.die(new RpcRateLimitError());
      }
      yield* annotateRpcSpan(method, traceAttributes);
      const startedAt = Date.now();
      const exit = yield* Effect.exit(effect);

      if (Exit.isFailure(exit)) {
        yield* recordRpcStreamMetrics(method, startedAt, exit);
        return yield* Effect.failCause(exit.cause);
      }

      return exit.value.pipe(
        Stream.onExit((streamExit) => recordRpcStreamMetrics(method, startedAt, streamExit)),
      );
    }),
  );
