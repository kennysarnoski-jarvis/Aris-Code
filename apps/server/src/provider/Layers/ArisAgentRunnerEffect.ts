/**
 * ArisAgentRunnerEffect — thin Effect wrapper around `runArisAgent`.
 *
 * `runArisAgent` is Promise-based by design — it has to be, because
 * the OpenAI Agents SDK is built on async/await and Promise streams.
 * ArisAdapter, however, is built on Effect. This module bridges the
 * two so ArisAdapter can call the runner from inside an `Effect.gen`
 * block as if it were a native Effect.
 *
 * What changes vs the Promise version:
 *   - `emitter: ArisAgentEventEmitter` → `publish: (event) =>
 *     Effect.Effect<void>`. Production wires this to `publishArisEvent`
 *     directly (which already returns `Effect.Effect<void>`), so the
 *     ergonomics inside ArisAdapter's gen-function are clean:
 *
 *         yield* runArisAgentEffect({
 *           agent, prompt, threadId, turnId, userMessageId, runtimeMode,
 *           publish: publishArisEvent,
 *         });
 *
 *   - Errors come back as `Effect<RunArisAgentResult, Error>`. The
 *     calling code can pipe `Effect.catch` to translate into the
 *     ProviderAdapter-typed errors ArisAdapter already uses
 *     (ProviderAdapterRequestError etc.) — same pattern the rest of
 *     the file follows for fetch failures.
 *
 * Internal mechanics:
 *   The Effect-based `publish` is converted into a Promise-based
 *   emitter at the boundary by running each publish call through
 *   `Effect.runPromise`. This works because `publishArisEvent` is a
 *   no-context, no-error Effect (just calls into the in-memory PubSub),
 *   so `runPromise` doesn't need a runtime layer. If a future emitter
 *   publish depends on layered services, this bridge would need
 *   refactoring to capture and reuse the parent runtime — out of
 *   scope for now.
 *
 * @module ArisAgentRunnerEffect
 */
import { Effect } from "effect";

import type { ArisEvent } from "@t3tools/contracts";

import { ProviderAdapterRequestError } from "../Errors.ts";

import {
  type ArisAgentEventEmitter,
  type RunArisAgentOptions,
  type RunArisAgentResult,
  runArisAgent,
} from "./ArisAgentRunner.ts";

const PROVIDER = "aris";

/**
 * Same shape as `RunArisAgentOptions` but with the emitter replaced
 * by an Effect-returning publish function. Caller passes
 * `publishArisEvent` directly.
 */
export interface RunArisAgentEffectOptions extends Omit<RunArisAgentOptions, "emitter"> {
  readonly publish: (event: ArisEvent) => Effect.Effect<void>;
}

/**
 * Effect-flavored entry point. Use from inside an Effect.gen block.
 *
 * Errors from the SDK (fetch failures, rate limits, malformed
 * responses) are surfaced as `ProviderAdapterRequestError` — same
 * tagged error class the rest of ArisAdapter uses for HTTP failures,
 * so the existing catch handler at the top of `runTurnStreaming`
 * already knows how to surface them as `aris.turn.failed` events.
 */
export const runArisAgentEffect = (
  opts: RunArisAgentEffectOptions,
): Effect.Effect<RunArisAgentResult, ProviderAdapterRequestError> =>
  Effect.tryPromise({
    try: async () => {
      // Build a Promise-based emitter that runs each Effect-based
      // publish to completion. `Effect.runPromise` is safe here
      // because publishArisEvent is `Effect<void, never, never>`
      // (in-memory PubSub publish, no context).
      const emitter: ArisAgentEventEmitter = {
        publish: (event) => Effect.runPromise(opts.publish(event)),
      };
      const { publish: _stripped, ...rest } = opts;
      return runArisAgent({ ...rest, emitter });
    },
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "runArisAgent",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
