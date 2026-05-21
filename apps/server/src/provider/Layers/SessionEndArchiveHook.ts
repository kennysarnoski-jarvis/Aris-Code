/**
 * SessionEndArchiveHook — fires on real session stop (Slice Z.3).
 *
 * Rare in Kenny's UX (users typically abandon threads by opening new
 * ones, not by clicking a "stop" button), but the hook exists for
 * completeness: process shutdown, explicit user-initiated stop,
 * future programmatic teardown paths.
 *
 * Destructive. When fired:
 *   1. Slice Y's `archiveActiveWindowOnClose` renames `active.jsonl`
 *      → `window_NNN.jsonl` if it's ≥ THREAD_CLOSE_MIN_ACTIVE_BYTES.
 *   2. If the archive happened: fire
 *      `generateRolloverSummaryBackground` to produce
 *      `window_NNN.summary.md` from the freshly-archived window.
 *   3. Delete the now-superseded `active.summary.md` — the
 *      window-level summary is the canonical post-close summary, and
 *      keeping both around would let stale sidecar content drift.
 *
 * Errors: all swallowed. Worst case: active.jsonl stays where it is
 * and the sidecar remains, which still functions for cross-thread
 * memory via Slice Z.3.2's active.summary.md path.
 *
 * @module SessionEndArchiveHook
 */
import OpenAI from "openai";

import { deleteActiveSummary } from "./ActiveSummary.ts";
import { generateRolloverSummaryBackground } from "./DeepSeekRolloverSummary.ts";
import type { HookSpec, SessionEndContext } from "./HookTypes.ts";
import { archiveActiveWindowOnClose, type RollingWindowConfig } from "./RollingWindowMemory.ts";

const HOOK_NAME = "session-end-archive";
const HOOK_PRIORITY = 100;

export interface MakeSessionEndArchiveHookOptions {
  readonly rollingWindowConfig: RollingWindowConfig;
  /** Lazy DeepSeek client lookup. Same shape as StopActiveSummaryHook. */
  readonly lookupOpenAIClient: () => Promise<OpenAI | null>;
}

export function makeSessionEndArchiveHook(
  opts: MakeSessionEndArchiveHookOptions,
): Extract<HookSpec, { event: "SessionEnd" }> {
  const { rollingWindowConfig, lookupOpenAIClient } = opts;
  return {
    event: "SessionEnd",
    name: HOOK_NAME,
    priority: HOOK_PRIORITY,
    handler: async (ctx: SessionEndContext): Promise<void> => {
      if (!ctx.cwd) {
        return;
      }

      let archiveResult: Awaited<ReturnType<typeof archiveActiveWindowOnClose>>;
      try {
        archiveResult = await archiveActiveWindowOnClose(
          rollingWindowConfig,
          ctx.cwd,
          ctx.threadId,
        );
      } catch (err) {
        console.warn(
          `[${HOOK_NAME}] archive failed for ${ctx.threadId}: ${(err as Error).message}`,
        );
        return;
      }

      if (!archiveResult.archived) {
        // Nothing to archive (no active.jsonl, or below threshold).
        // The active.summary.md sidecar (if any) stays where it is —
        // there's no window summary to supersede it.
        return;
      }

      // Archive happened. Fire the rollover summary, then delete the
      // now-superseded active.summary.md (the window summary will
      // take its place once Pro returns).
      let openaiClient: OpenAI | null;
      try {
        openaiClient = await lookupOpenAIClient();
      } catch (err) {
        console.warn(
          `[${HOOK_NAME}] OpenAI client lookup failed for ${ctx.threadId}: ${(err as Error).message}`,
        );
        openaiClient = null;
      }

      if (openaiClient !== null) {
        generateRolloverSummaryBackground({
          rollingWindowConfig,
          cwd: ctx.cwd,
          threadId: ctx.threadId,
          windowIndex: archiveResult.windowIndex,
          archivedPath: archiveResult.archivedPath,
          openaiClient,
        });
      } else {
        console.warn(
          `[${HOOK_NAME}] cloud not configured, archived window_${archiveResult.windowIndex} ` +
            `for ${ctx.threadId} but cannot generate summary`,
        );
      }

      // Delete the active sidecar — superseded by the upcoming
      // window summary. Cross-thread scan will fall back to the
      // window summary on next read.
      try {
        await deleteActiveSummary(rollingWindowConfig, ctx.cwd, ctx.threadId);
      } catch (err) {
        console.warn(
          `[${HOOK_NAME}] failed to delete active.summary.md for ${ctx.threadId}: ${(err as Error).message}`,
        );
      }
    },
  };
}
