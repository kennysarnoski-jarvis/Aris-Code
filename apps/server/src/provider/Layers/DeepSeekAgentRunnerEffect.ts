/**
 * DeepSeekAgentRunnerEffect — thin Effect wrapper around
 * `runDeepSeekAgent`.
 *
 * Same bridging job as `ArisAgentRunnerEffect`: the OpenAI Agents SDK
 * is Promise-based, but the adapter layer (`DeepSeekAdapter`, Slice
 * 33f) is built on Effect. This module exposes the runner as an
 * Effect so the adapter can call it from inside an `Effect.gen`
 * block.
 *
 * What changes vs the Promise version:
 *   - `emitter: DeepSeekAgentEventEmitter` becomes
 *     `publish: (event) => Effect.Effect<void>`. Production wires
 *     this to `publishArisEvent` (the same bus Aris uses) so the
 *     ergonomics inside `DeepSeekAdapter`'s gen-function are clean:
 *
 *         yield* runDeepSeekAgentEffect({
 *           agent, prompt, threadId, turnId, userMessageId, runtimeMode,
 *           publish: publishArisEvent,
 *         });
 *
 *   - Errors come back as
 *     `Effect<RunDeepSeekAgentResult, ProviderAdapterRequestError>`.
 *     The calling code can pipe `Effect.catch` to translate into
 *     more specific failure types if needed (rate-limit
 *     classification, etc.) — same pattern Aris uses today.
 *
 * Internal mechanics:
 *   `Effect.runPromise` is safe at the publish boundary because
 *   `publishArisEvent` is `Effect<void, never, never>` — no context,
 *   no error, just an in-memory PubSub publish. If a future bus
 *   needs a layered service, this bridge would need refactoring to
 *   capture and reuse the parent runtime — out of scope for now.
 *
 * @module DeepSeekAgentRunnerEffect
 */
import { Effect } from "effect";

import type { ArisEvent } from "@t3tools/contracts";

import { ProviderAdapterRequestError } from "../Errors.ts";

import {
  type DeepSeekAgentEventEmitter,
  type RunDeepSeekAgentOptions,
  type RunDeepSeekAgentResult,
  runDeepSeekAgent,
} from "./DeepSeekAgentRunner.ts";

const PROVIDER = "deepseek";

/**
 * Same shape as `RunDeepSeekAgentOptions` but with the emitter
 * replaced by an Effect-returning publish function. Caller passes
 * `publishArisEvent` directly.
 */
export interface RunDeepSeekAgentEffectOptions extends Omit<RunDeepSeekAgentOptions, "emitter"> {
  readonly publish: (event: ArisEvent) => Effect.Effect<void>;
}

/**
 * Effect-flavored entry point. Use from inside an Effect.gen block.
 *
 * Errors from the SDK (cloud trusted-caller HTTP failures, DeepSeek
 * upstream errors surfaced through the cloud, malformed responses)
 * are surfaced as `ProviderAdapterRequestError` — same tagged error
 * class the rest of the provider stack uses for HTTP failures, so the
 * existing catch handler at the top of the adapter's
 * `runTurnStreaming` already knows how to surface them as
 * `aris.turn.failed` events.
 */
export const runDeepSeekAgentEffect = (
  opts: RunDeepSeekAgentEffectOptions,
): Effect.Effect<RunDeepSeekAgentResult, ProviderAdapterRequestError> =>
  Effect.tryPromise({
    try: async () => {
      const emitter: DeepSeekAgentEventEmitter = {
        publish: (event) => Effect.runPromise(opts.publish(event)),
      };
      const { publish: _stripped, ...rest } = opts;
      return runDeepSeekAgent({ ...rest, emitter });
    },
    catch: (cause) =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: "runDeepSeekAgent",
        detail: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
