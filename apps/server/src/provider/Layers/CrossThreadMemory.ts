/**
 * CrossThreadMemory — surfaces a brief slice of prior-thread context
 * to a fresh thread, mirroring Claude Code's session-start pattern.
 *
 * Architecture (Slice X):
 *
 * Every rolling-window rollover produces a `window_NNN.summary.md`
 * file. These are already on disk from prior threads, sitting unused
 * — the existing archive tools are scoped to THIS thread's archives
 * only. Cross-thread memory closes that gap without generating
 * anything new: we scan the project's sessions directory, pick the
 * most recent OTHER thread's most recent summary, and surface it
 * once at thread start.
 *
 * Design notes:
 *
 *   - **Project-scoped by construction.** The scan walks
 *     `~/.aris/projects/<projectKey>/sessions/` where `projectKey`
 *     derives from cwd. The function physically cannot reach into
 *     another project's sessions — same isolation boundary as the
 *     existing rolling-window paths.
 *
 *   - **Most recent ONE.** Not top-N. Claude Code's session-start
 *     hook reads the single most recent session file, and that's
 *     the right shape: model gets a briefing, not a manifest.
 *
 *   - **14-day recency window.** Coding projects span longer than
 *     Claude Code's 7-day default. Summaries older than 14 days fall
 *     out automatically — stale context from a deprecated approach
 *     should not leak into a fresh thread.
 *
 *   - **Current thread excluded.** The scan skips
 *     `<currentThreadId>` so a long-running thread that just rolled
 *     over doesn't see its OWN rollup surfaced as "prior context."
 *
 *   - **One injection, not per-turn.** Callers integrate the
 *     returned block into the system prompt assembly. The block is
 *     stable across turns within a thread (the "most recent prior
 *     thread" doesn't move during a single conversation), so prefix
 *     cache keeps the cost flat.
 *
 *   - **No new LLM calls.** This is pure file-system scan +
 *     read. The summaries themselves are produced by the existing
 *     rolling-window rollover path (see DeepSeekRolloverSummary).
 *
 * Gap (acknowledged for V1):
 *
 *   Threads that never rolled over (short conversations under the
 *   920K token threshold) have no summary file and don't show up in
 *   the scan. That's OK — short threads are typically self-contained
 *   one-shot tasks; the project-scoped scratchpad already covers
 *   anything important the user wanted carried forward. V2 (a
 *   thread-close hook that fires the rollover summary path against
 *   the un-rolled-over `active.jsonl`) closes this gap by reusing
 *   the same code path — no parallel format.
 *
 * @module CrossThreadMemory
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

import { ACTIVE_SUMMARY_FILENAME } from "./ActiveSummary.ts";
import { projectKeyFromCwd, type RollingWindowConfig } from "./RollingWindowMemory.ts";

/**
 * Maximum age of a prior-thread summary that's still considered
 * relevant. Older summaries are dropped from the scan so a fresh
 * thread isn't briefed on a deprecated approach from months ago.
 *
 * 14 days matches the typical coding-project rhythm — long enough
 * that a paused-and-resumed week-old project still has continuity,
 * short enough that abandoned experiments don't pollute new work.
 *
 * Claude Code's session-start hook uses 7 days; ours is wider
 * because Aris Code sessions span longer (a coding arc can run for
 * a couple weeks vs. Claude Code's typical single-session usage).
 */
export const CROSS_THREAD_RECENCY_DAYS = 14;
const CROSS_THREAD_RECENCY_MS = CROSS_THREAD_RECENCY_DAYS * 24 * 60 * 60 * 1000;

const PROJECTS_SUBDIR = "projects";
const SESSIONS_SUBDIR = "sessions";
const WINDOW_FILENAME_PREFIX = "window_";
const SUMMARY_FILENAME_SUFFIX = ".summary.md";

/**
 * Source of the surfaced summary.
 *   - `"rollover"` → the prior thread had a 920K rollover, so the
 *     summary lives at `window_NNN.summary.md` (the existing path).
 *   - `"active"` → the prior thread is in-flight (Slice Z.3 sidecar),
 *     summary lives at `active.summary.md`. `windowIndex` is 0 in
 *     this case as a sentinel since no window has been sealed yet.
 */
export type PriorThreadSummarySource = "rollover" | "active";

/**
 * Shape returned when a prior-thread summary is available. `null`
 * is returned (not this shape) when nothing matches — callers
 * branch on the null check, not on a `present` flag.
 */
export interface PriorThreadSummary {
  /** Thread id whose summary is being surfaced. */
  readonly threadId: string;
  /** Where the summary came from — see `PriorThreadSummarySource`. */
  readonly source: PriorThreadSummarySource;
  /**
   * Index of the rolled-over window for `"rollover"` summaries.
   * Always `0` for `"active"` summaries (no window has been sealed
   * yet — the active.jsonl is still in-flight).
   */
  readonly windowIndex: number;
  /** Wall-clock mtime of the summary file (ms since epoch). */
  readonly mtimeMs: number;
  /** Full text of the summary markdown file. */
  readonly summaryText: string;
}

/**
 * Scan the project's sessions directory and return the single most
 * recent prior-thread summary, or `null` if nothing qualifies.
 *
 * Selection rules (in order):
 *   1. Exclude `currentThreadId` — a thread doesn't brief itself.
 *   2. For each remaining thread directory, find the highest-numbered
 *      `window_NNN.summary.md` file (the latest rollover).
 *   3. Filter out summaries with mtime older than
 *      `CROSS_THREAD_RECENCY_DAYS` from now.
 *   4. Of the survivors, pick the one with the latest mtime.
 *
 * Returns `null` when the sessions directory doesn't exist (fresh
 * project), when no other thread has rolled over yet, or when every
 * candidate is past the recency window. Read errors on the chosen
 * summary are logged + treated as `null` so a single corrupt file
 * doesn't break thread start.
 *
 * `nowMs` is injected so tests can pin "now" against fixture mtimes
 * without depending on `Date.now()`. Production callers omit it.
 */
export async function collectMostRecentPriorThreadSummary(
  config: RollingWindowConfig,
  cwd: string,
  currentThreadId: string,
  opts?: { readonly nowMs?: number },
): Promise<PriorThreadSummary | null> {
  const sessionsDir = join(
    config.arisHomeDir,
    PROJECTS_SUBDIR,
    projectKeyFromCwd(cwd),
    SESSIONS_SUBDIR,
  );

  let threadDirs: string[];
  try {
    threadDirs = await fs.readdir(sessionsDir);
  } catch (err) {
    // ENOENT is the fresh-project case — no sessions dir yet. Anything
    // else is an unexpected failure; log it but don't fail the thread.
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[CrossThreadMemory] sessions dir read failed at ${sessionsDir}: ${(err as Error).message}`,
      );
    }
    return null;
  }

  const now = opts?.nowMs ?? Date.now();
  const cutoffMs = now - CROSS_THREAD_RECENCY_MS;

  let best: PriorThreadSummary | null = null;

  for (const threadId of threadDirs) {
    if (threadId === currentThreadId) continue;
    // Defense-in-depth: anything that doesn't look like a thread-id
    // slug gets skipped. The on-disk directory shape is controlled by
    // `assertSafeThreadId` upstream, but we don't trust the scan
    // result blindly — symlinks, leftover dotfiles, or future format
    // additions should not be treated as thread directories.
    if (threadId.length === 0 || threadId.startsWith(".")) continue;

    const threadDir = join(sessionsDir, threadId);
    let entries: string[];
    try {
      entries = await fs.readdir(threadDir);
    } catch {
      // Permission errors or a file-where-a-dir-was-expected: skip
      // silently. One bad thread directory shouldn't blow up the
      // whole cross-thread scan.
      continue;
    }

    // For each thread, consider BOTH the latest window_NNN.summary.md
    // (post-rollover summary) and active.summary.md (in-flight Slice
    // Z.3 sidecar). Pick whichever has the freshest mtime as that
    // thread's candidate. Then across all threads, the outermost loop
    // picks the freshest candidate.

    // Highest-numbered window summary in this thread, if any.
    let bestWindowIndex = 0;
    let bestWindowName: string | null = null;
    let hasActiveSummary = false;
    for (const name of entries) {
      if (name === ACTIVE_SUMMARY_FILENAME) {
        hasActiveSummary = true;
        continue;
      }
      if (!name.startsWith(WINDOW_FILENAME_PREFIX)) continue;
      if (!name.endsWith(SUMMARY_FILENAME_SUFFIX)) continue;
      const middle = name.slice(WINDOW_FILENAME_PREFIX.length, -SUMMARY_FILENAME_SUFFIX.length);
      const n = Number.parseInt(middle, 10);
      if (!Number.isFinite(n) || n <= bestWindowIndex) continue;
      bestWindowIndex = n;
      bestWindowName = name;
    }
    if (!bestWindowName && !hasActiveSummary) continue;

    // Stat both candidates (when each exists) and pick the fresher one.
    let chosenPath: string | null = null;
    let chosenMtime = -Infinity;
    let chosenSource: PriorThreadSummarySource = "rollover";
    let chosenWindowIndex = 0;

    if (bestWindowName) {
      const path = join(threadDir, bestWindowName);
      try {
        const stat = await fs.stat(path);
        if (stat.mtimeMs > chosenMtime) {
          chosenMtime = stat.mtimeMs;
          chosenPath = path;
          chosenSource = "rollover";
          chosenWindowIndex = bestWindowIndex;
        }
      } catch {
        // Window summary disappeared between readdir and stat —
        // ignore and fall back to active if available.
      }
    }
    if (hasActiveSummary) {
      const path = join(threadDir, ACTIVE_SUMMARY_FILENAME);
      try {
        const stat = await fs.stat(path);
        if (stat.mtimeMs > chosenMtime) {
          chosenMtime = stat.mtimeMs;
          chosenPath = path;
          chosenSource = "active";
          chosenWindowIndex = 0;
        }
      } catch {
        // Same defense as above.
      }
    }
    if (chosenPath === null) continue;
    if (chosenMtime < cutoffMs) continue;

    // Found a candidate. Replace `best` only if this one is more recent.
    if (best !== null && chosenMtime <= best.mtimeMs) continue;

    let summaryText: string;
    try {
      summaryText = await fs.readFile(chosenPath, "utf8");
    } catch (err) {
      console.warn(`[CrossThreadMemory] failed to read ${chosenPath}: ${(err as Error).message}`);
      continue;
    }

    best = {
      threadId,
      source: chosenSource,
      windowIndex: chosenWindowIndex,
      mtimeMs: chosenMtime,
      summaryText,
    };
  }

  return best;
}

/**
 * Render a `PriorThreadSummary` into the `<thread_history>` block
 * that gets injected into the system prompt. Separate from the
 * collection function so callers can compose differently (e.g. tests
 * assert structure without parsing the wrapper text).
 */
export function renderPriorThreadSummary(summary: PriorThreadSummary): string {
  return (
    `<thread_history thread_id="${summary.threadId}" ` +
    `source="${summary.source}" ` +
    `window_index="${summary.windowIndex}" ` +
    `mtime_iso="${new Date(summary.mtimeMs).toISOString()}">\n` +
    summary.summaryText.trimEnd() +
    "\n</thread_history>"
  );
}
