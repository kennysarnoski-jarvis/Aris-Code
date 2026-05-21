/**
 * StopActiveSummaryHook — fires after every assistant turn (Slice Z.3).
 *
 * Non-destructive. Reads `active.jsonl`'s size, checks the debounce
 * (must have grown ≥ ACTIVE_SUMMARY_RESUMMARIZE_BYTES since the last
 * write), and if appropriate, fires
 * `generateActiveSummaryBackground` in the background. The Pro call
 * happens detached from the turn loop so a slow summary never blocks
 * Kenny's next prompt.
 *
 * Closes the cross-thread memory gap Slice X left open: short threads
 * (under 920K, the common case) now produce `active.summary.md` files
 * that CrossThreadMemory's scan surfaces to future threads in the
 * same project.
 *
 * Errors: all swallowed. Fire-and-forget. Worst case: no summary,
 * next thread doesn't see this one in its cross-thread briefing.
 *
 * @module StopActiveSummaryHook
 */
import OpenAI from "openai";

import { generateActiveSummaryBackground, shouldGenerateActiveSummary } from "./ActiveSummary.ts";
import type { HookSpec, StopContext } from "./HookTypes.ts";
import type { RollingWindowConfig } from "./RollingWindowMemory.ts";

const HOOK_NAME = "stop-active-summary";
const HOOK_PRIORITY = 100;

export interface MakeStopActiveSummaryHookOptions {
  readonly rollingWindowConfig: RollingWindowConfig;
  /**
   * Lazy lookup for the DeepSeek OpenAI client. Called only when a
   * summary actually needs to be generated. Returns `null` when the
   * cloud config isn't set, so the hook can skip without erroring.
   *
   * Passed as a closure (rather than the client directly) because
   * server settings can change at runtime — we want the fresh value
   * each fire, not a snapshot from adapter startup.
   */
  readonly lookupOpenAIClient: () => Promise<OpenAI | null>;
}

export function makeStopActiveSummaryHook(
  opts: MakeStopActiveSummaryHookOptions,
): Extract<HookSpec, { event: "Stop" }> {
  const { rollingWindowConfig, lookupOpenAIClient } = opts;
  return {
    event: "Stop",
    name: HOOK_NAME,
    priority: HOOK_PRIORITY,
    handler: async (ctx: StopContext): Promise<void> => {
      // No cwd → no project key → can't resolve a sessions dir. The
      // session can still run, it just doesn't participate in cross-
      // thread memory.
      if (!ctx.cwd) {
        return;
      }

      let decision: Awaited<ReturnType<typeof shouldGenerateActiveSummary>>;
      try {
        decision = await shouldGenerateActiveSummary(rollingWindowConfig, ctx.cwd, ctx.threadId);
      } catch (err) {
        console.warn(
          `[${HOOK_NAME}] shouldGenerate check failed for ${ctx.threadId}: ${(err as Error).message}`,
        );
        return;
      }

      if (!decision.shouldGenerate) {
        return;
      }

      let openaiClient: OpenAI | null;
      try {
        openaiClient = await lookupOpenAIClient();
      } catch (err) {
        console.warn(
          `[${HOOK_NAME}] OpenAI client lookup failed for ${ctx.threadId}: ${(err as Error).message}`,
        );
        return;
      }
      if (openaiClient === null) {
        // Cloud not configured — skip silently. This is the "user
        // hasn't activated their subscription yet" case.
        return;
      }

      // Fire-and-forget. generateActiveSummaryBackground handles
      // in-flight de-duplication internally so a fast back-to-back
      // turn sequence doesn't queue redundant Pro calls.
      generateActiveSummaryBackground({
        rollingWindowConfig,
        cwd: ctx.cwd,
        threadId: ctx.threadId,
        openaiClient,
        observedActiveBytes: decision.currentBytes,
      });
    },
  };
}
