/**
 * DeepSeekEffortMapping — translate loose `effort:` frontmatter vocab
 * into DeepSeek V4's strict 3-level reasoning depth enum.
 *
 * Extracted from `DeepSeekAdapter` (Slice 4 — 2026-05-16) so both the
 * adapter's forkExecutor (skill `context: fork` mode) and
 * `DeepSeekAgentTool`'s spawn_worker template lookup can share the
 * same coercion logic. Without extraction the helper would have to
 * either be duplicated or imported back from the adapter, the latter
 * of which would create a circular dependency
 * (`DeepSeekAgentTool` → `DeepSeekAdapter` while
 * `DeepSeekAdapter` → `DeepSeekAgentTools` → `DeepSeekAgentTool`).
 *
 * Domain note: DeepSeek V4-Pro is a reasoning-first model. Per the
 * API recon memory, `reasoning_content` is ALWAYS produced regardless
 * of what we send — only the DEPTH is controllable. So these labels
 * describe how MUCH the model thinks, not whether. There's no true
 * "no thinking" mode — `light` strips the explicit `thinking: enabled`
 * flag so the server applies its default depth (still emits some
 * reasoning, just shallow).
 *
 * Vocabulary mapping (case-insensitive):
 *
 *   max | maximum | ultra                          → "max"
 *   high | medium | thinking | on | yes | true     → "high"
 *   low | minimal | off | no | false | light       → "light"
 *   non-think                                       → "light"  (legacy alias)
 *   anything else (or undefined)                   → undefined (cloud default)
 *
 * Returning `undefined` means "don't override" — the request goes out
 * without an explicit effort knob and the cloud applies its default
 * depth. Treating unknown values as `undefined` rather than throwing
 * means a typo in skill/template frontmatter just no-ops; it doesn't
 * crash the dispatch. Skill/template authors get loose vocabulary
 * (high/medium/thinking/on/yes all collapse to "high") while the
 * strict-3-level enum stays inside the DS V4 wire shape.
 *
 * Skill `effort:` and agent template `effort:` both flow through this.
 * The strict `effort: light | high | max` parameter on `spawn_worker`'s
 * Zod schema does NOT — it's already validated as the canonical enum
 * at parse time and passed through as-is.
 *
 * @module DeepSeekEffortMapping
 */
import type { DeepSeekReasoningEffort } from "@t3tools/contracts";

/**
 * Map a loose `effort:` frontmatter value to DeepSeek V4's three-level
 * reasoning depth. See module docstring for the full vocabulary table.
 *
 * Exported for use by:
 *   - `DeepSeekAdapter.forkExecutor` — skill `context: fork` dispatch.
 *   - `DeepSeekAgentTool` — spawn_worker template lookup (Slice 4).
 */
export function mapEffortToReasoningEffort(
  effort: string | undefined,
): DeepSeekReasoningEffort | undefined {
  if (!effort) return undefined;
  const normalized = effort.trim().toLowerCase();
  switch (normalized) {
    case "max":
    case "maximum":
    case "ultra":
      return "max";
    case "high":
    case "medium":
    case "thinking":
    case "on":
    case "yes":
    case "true":
      return "high";
    case "low":
    case "minimal":
    case "off":
    case "no":
    case "false":
    case "light":
    case "non-think": // legacy alias — kept so old frontmatter still maps cleanly
      return "light";
    default:
      return undefined;
  }
}
