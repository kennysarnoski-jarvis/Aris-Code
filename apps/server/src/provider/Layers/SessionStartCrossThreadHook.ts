/**
 * SessionStart hook — cross-thread memory injection (Slice X on the bus).
 *
 * Reads the most recent rollover summary from a prior thread in the
 * same project (within the 14-day recency window) and renders it as
 * a system-context block including:
 *   - Header explaining what the block is and how to read it
 *   - Archive-tool hints with the prior thread's id pre-filled so
 *     the model can dig deeper without guessing the id
 *   - The rendered `<thread_history>` summary itself
 *
 * Returns `{ inject: <fullBlock> }` when a prior summary exists,
 * or `{}` (no inject) when there's no current cwd, no prior
 * thread, or every prior thread's most recent rollover is older
 * than `CROSS_THREAD_RECENCY_DAYS`.
 *
 * Error handling matches Claude Code's session-start hook
 * convention: do not block session start on read failures. Errors
 * inside the hook are caught at the HookBus level and the session
 * proceeds without the cross-thread briefing.
 *
 * @module SessionStartCrossThreadHook
 */

import {
  collectMostRecentPriorThreadSummary,
  type PriorThreadSummary,
  renderPriorThreadSummary,
} from "./CrossThreadMemory.ts";
import type { HookSpec, SessionStartContext, SessionStartResult } from "./HookTypes.ts";
import type { RollingWindowConfig } from "./RollingWindowMemory.ts";

/**
 * Priority for the cross-thread SessionStart hook. Sits at the
 * default priority — if other SessionStart hooks register, they
 * compose with this one via the bus's `\n\n` join in priority order.
 */
const HOOK_PRIORITY = 100;

const HOOK_NAME = "session-start-cross-thread";

/**
 * Builds the full system-context block from a non-null prior thread
 * summary. The text mirrors what the adapter used to emit inline at
 * turn assembly — same boilerplate, same tool-id hints, same
 * `renderPriorThreadSummary` tail. Pulled out so the hook owns
 * rendering end-to-end and the adapter just receives an injectable
 * string.
 */
export function renderCrossThreadInjection(summary: PriorThreadSummary): string {
  return (
    "## Prior thread in this project\n\n" +
    "The summary below is the most recent rollover from " +
    "ANOTHER thread you worked on for this same project. " +
    "Read it once to orient — what was being worked on, " +
    "what decisions landed, what was still open. You do " +
    "NOT need to re-read it on every turn; it's stable " +
    "for the life of this thread.\n\n" +
    "## When to dig deeper\n\n" +
    "If the user references something from before that " +
    "the briefing doesn't fully cover, the archive tools " +
    "accept the prior thread's id explicitly:\n\n" +
    '- `list_archives(thread_id="' +
    summary.threadId +
    '")` — windows in that thread\n' +
    '- `search_archives(query, thread_id="' +
    summary.threadId +
    '")` — keyword search\n' +
    "- `read_archive_range(window_index, start_msg, end_msg, " +
    'thread_id="' +
    summary.threadId +
    '")` — pull a specific range\n\n' +
    "If the question is about THIS thread's earlier turns, " +
    "use the same tools without the `thread_id` arg.\n\n" +
    renderPriorThreadSummary(summary)
  );
}

/**
 * Factory: produce a SessionStart hook spec bound to the given
 * rolling-window config. The config is captured in the handler's
 * closure so the bus can call the handler with just a
 * `SessionStartContext` (no DI plumbing at dispatch time).
 *
 * Register on adapter setup:
 * ```ts
 * const hookBus = makeHookBus();
 * hookBus.register(makeSessionStartCrossThreadHook(rollingWindowConfig));
 * ```
 */
export function makeSessionStartCrossThreadHook(
  rollingWindowConfig: RollingWindowConfig,
): Extract<HookSpec, { event: "SessionStart" }> {
  return {
    event: "SessionStart",
    name: HOOK_NAME,
    priority: HOOK_PRIORITY,
    handler: async (ctx: SessionStartContext): Promise<SessionStartResult> => {
      // No cwd → no project key → can't scan prior threads. This
      // happens for "no folder open yet" sessions; the cross-thread
      // briefing simply doesn't apply.
      if (!ctx.cwd) {
        return {};
      }

      let summary: PriorThreadSummary | null;
      try {
        summary = await collectMostRecentPriorThreadSummary(
          rollingWindowConfig,
          ctx.cwd,
          ctx.threadId,
        );
      } catch (err) {
        // Match Slice X's existing behavior: log + skip. Throwing
        // here would cause the bus to log the same message AND drop
        // any sibling SessionStart hooks' injects. Catching locally
        // keeps siblings intact.
        console.warn(`[${HOOK_NAME}] cross-thread summary read failed: ${(err as Error).message}`);
        return {};
      }

      if (summary === null) {
        return {};
      }

      return { inject: renderCrossThreadInjection(summary) };
    },
  };
}
