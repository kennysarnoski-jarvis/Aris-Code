/**
 * RoutingTextGeneration – Dispatches text generation requests to the
 * provider-specific implementation (Codex CLI, Claude CLI, Aris HTTP,
 * or a synthetic fallback for DeepSeek) based on the provider in
 * each request input.
 *
 * Routing rules:
 *   - `modelSelection.provider === "claudeAgent"` → ClaudeTextGeneration
 *   - `modelSelection.provider === "aris"`        → ArisTextGeneration
 *   - `modelSelection.provider === "deepseek"`    → SyntheticTextGeneration
 *     (no real model call — we don't route DeepSeek-side text-gen
 *     through cloud yet; titles are synthesized client-side from the
 *     message preview, commit/PR/branch generation no-op rather than
 *     hitting Codex, which may be disabled when the user is on
 *     DeepSeek-only)
 *   - anything else (incl. `"codex"` and `undefined`) → CodexTextGeneration
 *
 * @module RoutingTextGeneration
 */
import { Effect, Layer, Context } from "effect";

import {
  TextGeneration,
  type TextGenerationProvider,
  type TextGenerationShape,
} from "../Services/TextGeneration.ts";
import { CodexTextGenerationLive } from "./CodexTextGeneration.ts";
import { ClaudeTextGenerationLive } from "./ClaudeTextGeneration.ts";
import { ArisTextGenerationLive } from "./ArisTextGeneration.ts";

/**
 * Inline first-N-words title synthesizer. Plenty good for DeepSeek
 * threads — the alternative was routing to Codex which fails hard
 * with "Invalid model selection" when Codex isn't enabled.
 */
function synthesizeTitleFromMessage(message: string): string {
  const words = message.trim().split(/\s+/).slice(0, 7);
  const joined = words.join(" ");
  return joined.length > 0 ? joined : "New thread";
}

/**
 * Synthetic text-gen for DeepSeek. Title-gen returns a preview of
 * the user's message; commit/PR/branch gen no-op with a placeholder
 * so the orchestration handlers don't throw. None of these hit a
 * model — DeepSeek-side text-gen via cloud trusted-caller is a
 * follow-up slice.
 */
const SyntheticDeepSeekTextGen: TextGenerationShape = {
  generateCommitMessage: () => Effect.succeed({ subject: "WIP", body: "" }),
  generatePrContent: () => Effect.succeed({ title: "WIP", body: "" }),
  generateBranchName: () => Effect.succeed({ branch: "wip" }),
  generateThreadTitle: (input) =>
    Effect.succeed({ title: synthesizeTitleFromMessage(input.message) }),
};

// ---------------------------------------------------------------------------
// Internal service tags so all concrete layers can coexist.
// ---------------------------------------------------------------------------

class CodexTextGen extends Context.Service<CodexTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/CodexTextGen",
) {}

class ClaudeTextGen extends Context.Service<ClaudeTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/ClaudeTextGen",
) {}

class ArisTextGen extends Context.Service<ArisTextGen, TextGenerationShape>()(
  "t3/git/Layers/RoutingTextGeneration/ArisTextGen",
) {}

// ---------------------------------------------------------------------------
// Routing implementation
// ---------------------------------------------------------------------------

const makeRoutingTextGeneration = Effect.gen(function* () {
  const codex = yield* CodexTextGen;
  const claude = yield* ClaudeTextGen;
  const aris = yield* ArisTextGen;

  const route = (provider?: TextGenerationProvider): TextGenerationShape => {
    if (provider === "claudeAgent") return claude;
    if (provider === "aris") return aris;
    if (provider === "deepseek") return SyntheticDeepSeekTextGen;
    return codex;
  };

  return {
    generateCommitMessage: (input) =>
      route(input.modelSelection.provider).generateCommitMessage(input),
    generatePrContent: (input) => route(input.modelSelection.provider).generatePrContent(input),
    generateBranchName: (input) => route(input.modelSelection.provider).generateBranchName(input),
    generateThreadTitle: (input) => route(input.modelSelection.provider).generateThreadTitle(input),
  } satisfies TextGenerationShape;
});

const InternalCodexLayer = Layer.effect(
  CodexTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(CodexTextGenerationLive));

const InternalClaudeLayer = Layer.effect(
  ClaudeTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(ClaudeTextGenerationLive));

const InternalArisLayer = Layer.effect(
  ArisTextGen,
  Effect.gen(function* () {
    const svc = yield* TextGeneration;
    return svc;
  }),
).pipe(Layer.provide(ArisTextGenerationLive));

export const RoutingTextGenerationLive = Layer.effect(
  TextGeneration,
  makeRoutingTextGeneration,
).pipe(
  Layer.provide(InternalCodexLayer),
  Layer.provide(InternalClaudeLayer),
  Layer.provide(InternalArisLayer),
);
