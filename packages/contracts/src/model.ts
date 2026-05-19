import { Schema } from "effect";
import { TrimmedNonEmptyString } from "./baseSchemas";
import type { ProviderKind } from "./orchestration";

export const CODEX_REASONING_EFFORT_OPTIONS = ["xhigh", "high", "medium", "low"] as const;
export type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORT_OPTIONS)[number];
export const CLAUDE_CODE_EFFORT_OPTIONS = ["low", "medium", "high", "max", "ultrathink"] as const;
export type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORT_OPTIONS)[number];
/**
 * Slice 33a — DeepSeek V4's three reasoning depth modes.
 *
 * Important: DeepSeek V4-Pro is a reasoning-first model. Per the API
 * recon memory, `reasoning_content` is ALWAYS produced regardless of
 * what we send — only the DEPTH is controllable. So these labels
 * describe how MUCH the model thinks, not whether.
 *
 *   - "light" → strip thinking flags; model defaults to baseline
 *               (still emits reasoning_content, just shallower)
 *   - "high"  → thinking: {type: "enabled"} + reasoning_effort: "high"
 *   - "max"   → thinking: {type: "enabled"} + reasoning_effort: "max"
 *
 * Maps to the API's `thinking: {type: "enabled"}` + `reasoning_effort` flags
 * (the curl recon memory has the exact wire shape).
 */
export const DEEPSEEK_REASONING_EFFORT_OPTIONS = ["light", "high", "max"] as const;
export type DeepSeekReasoningEffort = (typeof DEEPSEEK_REASONING_EFFORT_OPTIONS)[number];

/**
 * Canonical DeepSeek model slugs exposed to provider-side code. Drives
 * Zod-enum validation in tools that accept a per-call model override
 * (e.g. `spawn_worker`'s `model` parameter — see DeepSeekAgentTool).
 *
 * Kept in sync with `DEFAULT_MODEL_BY_PROVIDER.deepseek`,
 * `DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER.deepseek`, and the
 * canonical targets in `MODEL_SLUG_ALIASES_BY_PROVIDER.deepseek`. When
 * DeepSeek adds a new model tier (e.g. a future V4-Mini), append it
 * here so the provider-side Zod validation accepts it without an
 * unsafe `z.string()` widening.
 */
export const DEEPSEEK_MODEL_SLUGS = ["deepseek-v4-pro", "deepseek-v4-flash"] as const;
export type DeepSeekModelSlug = (typeof DEEPSEEK_MODEL_SLUGS)[number];
export type ProviderReasoningEffort =
  | CodexReasoningEffort
  | ClaudeCodeEffort
  | DeepSeekReasoningEffort;

export const CodexModelOptions = Schema.Struct({
  reasoningEffort: Schema.optional(Schema.Literals(CODEX_REASONING_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
});
export type CodexModelOptions = typeof CodexModelOptions.Type;

export const ClaudeModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
  effort: Schema.optional(Schema.Literals(CLAUDE_CODE_EFFORT_OPTIONS)),
  fastMode: Schema.optional(Schema.Boolean),
  contextWindow: Schema.optional(Schema.String),
});
export type ClaudeModelOptions = typeof ClaudeModelOptions.Type;

export const ArisModelOptions = Schema.Struct({
  thinking: Schema.optional(Schema.Boolean),
});
export type ArisModelOptions = typeof ArisModelOptions.Type;

export const DeepSeekModelOptions = Schema.Struct({
  /**
   * Per-message reasoning effort. Defaults to server choice when omitted
   * (currently "high" — see the curl recon memory for rationale).
   */
  effort: Schema.optional(Schema.Literals(DEEPSEEK_REASONING_EFFORT_OPTIONS)),
});
export type DeepSeekModelOptions = typeof DeepSeekModelOptions.Type;

export const ProviderModelOptions = Schema.Struct({
  codex: Schema.optional(CodexModelOptions),
  claudeAgent: Schema.optional(ClaudeModelOptions),
  aris: Schema.optional(ArisModelOptions),
  deepseek: Schema.optional(DeepSeekModelOptions),
});
export type ProviderModelOptions = typeof ProviderModelOptions.Type;

export const EffortOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type EffortOption = typeof EffortOption.Type;

export const ContextWindowOption = Schema.Struct({
  value: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  isDefault: Schema.optional(Schema.Boolean),
});
export type ContextWindowOption = typeof ContextWindowOption.Type;

export const ModelCapabilities = Schema.Struct({
  reasoningEffortLevels: Schema.Array(EffortOption),
  supportsFastMode: Schema.Boolean,
  supportsThinkingToggle: Schema.Boolean,
  contextWindowOptions: Schema.Array(ContextWindowOption),
  promptInjectedEffortLevels: Schema.Array(TrimmedNonEmptyString),
});
export type ModelCapabilities = typeof ModelCapabilities.Type;

export const DEFAULT_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-5.4",
  claudeAgent: "claude-sonnet-4-6",
  aris: "qwen-3.6",
  // V4-Pro is the flagship — 1.6T/49B MoE, 1M context, premium positioning
  // per Kenny's call. V4-Flash is offered as a "fast cheap" option in the
  // model picker (see MODEL_SLUG_ALIASES_BY_PROVIDER below).
  deepseek: "deepseek-v4-pro",
};

export const DEFAULT_MODEL = DEFAULT_MODEL_BY_PROVIDER.codex;

/** Per-provider text generation model defaults. */
export const DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER: Record<ProviderKind, string> = {
  codex: "gpt-5.4-mini",
  claudeAgent: "claude-haiku-4-5",
  aris: "qwen-3.6",
  // Flash is ~10x cheaper than Pro — right call for the small text-gen
  // tasks (commit messages, branch names, etc.) where Pro is overkill.
  deepseek: "deepseek-v4-flash",
};

export const MODEL_SLUG_ALIASES_BY_PROVIDER: Record<ProviderKind, Record<string, string>> = {
  codex: {
    "gpt-5-codex": "gpt-5.4",
    "5.4": "gpt-5.4",
    "5.3": "gpt-5.3-codex",
    "gpt-5.3": "gpt-5.3-codex",
    "5.3-spark": "gpt-5.3-codex-spark",
    "gpt-5.3-spark": "gpt-5.3-codex-spark",
  },
  claudeAgent: {
    opus: "claude-opus-4-6",
    "opus-4.6": "claude-opus-4-6",
    "claude-opus-4.6": "claude-opus-4-6",
    "claude-opus-4-6-20251117": "claude-opus-4-6",
    sonnet: "claude-sonnet-4-6",
    "sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4.6": "claude-sonnet-4-6",
    "claude-sonnet-4-6-20251117": "claude-sonnet-4-6",
    haiku: "claude-haiku-4-5",
    "haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4.5": "claude-haiku-4-5",
    "claude-haiku-4-5-20251001": "claude-haiku-4-5",
  },
  aris: {
    cascade: "qwen-3.6",
    "cascade-2": "qwen-3.6",
    "nemotron-cascade-2": "qwen-3.6",
  },
  deepseek: {
    pro: "deepseek-v4-pro",
    "v4-pro": "deepseek-v4-pro",
    v4: "deepseek-v4-pro",
    flash: "deepseek-v4-flash",
    "v4-flash": "deepseek-v4-flash",
  },
};

// ── Provider display names ────────────────────────────────────────────

// Cosmetic relabel (2026-05-10): the "deepseek" provider key is surfaced
// to users as "Aris". The internal key, channel names, and routing all
// stay `"deepseek"` — this is display-only. The legacy `"aris"` provider
// (Qwen3.6 / RunPod) is hidden in the picker + settings; its label is
// preserved here for any code paths that still reference it directly.
export const PROVIDER_DISPLAY_NAMES: Record<ProviderKind, string> = {
  codex: "Codex",
  claudeAgent: "Claude",
  aris: "Aris",
  deepseek: "Aris",
};
