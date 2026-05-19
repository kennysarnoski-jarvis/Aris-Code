/**
 * DeepSeekSessionScratchpadTools — read/append tools for the
 * coordinator-session-scoped scratchpad shared across workers within
 * one parent turn.
 *
 * Slice COORD-5: Solves the "workers can't see each other's findings"
 * gap from Aris's coordinator critique. Two tools, both available
 * to the parent AND to spawned workers (so worker N+1 can read what
 * worker N wrote, parent can read everything for synthesis):
 *
 *   - `read_session_scratchpad` — return all entries written this
 *     turn, grouped by writer.
 *   - `append_session_scratchpad` — write a new entry tagged with
 *     the writer's identity (parent name OR worker description).
 *
 * The path is derived from (cwd, threadId, parentTurnId). The
 * parentTurnId is captured at adapter time and stays stable for the
 * whole turn. Workers spawned within that turn share the same
 * parentTurnId so they all read/write the same file.
 *
 * @module DeepSeekSessionScratchpadTools
 */
import { tool } from "@openai/agents";
import { z } from "zod";

import type { ArisEvent, TurnId } from "@t3tools/contracts";
import type { RollingWindowConfig } from "./RollingWindowMemory.ts";

import {
  appendSessionScratchpadEntry,
  newSessionScratchpadEntry,
  readSessionScratchpadEntries,
  renderSessionScratchpad,
} from "./SessionScratchpadMemory.ts";

export interface SessionScratchpadToolContext {
  /**
   * Slice L / M3-2 — resolved rolling-window paths threaded from the
   * adapter so session-scratchpad IO doesn't reach for `homedir()`
   * implicitly.
   */
  readonly rollingWindowConfig: RollingWindowConfig;
  /** Workspace cwd — used to derive the per-thread archive directory. */
  readonly cwd: string;
  /** Thread id — selects the per-thread directory under projects/<key>/sessions/. */
  readonly threadId: string;
  /**
   * Parent's turn id — keys the scratchpad file so concurrent turns
   * don't collide. Captured once when the adapter builds the parent
   * agent's tool list, then plumbed to spawn_worker so workers share
   * it.
   */
  readonly parentTurnId: string;
  /**
   * Identity of THIS writer — "parent" when the tool is registered
   * for the coordinator, the worker's description when registered
   * for a worker. Stamped onto every appended entry so the reader
   * can tell who contributed what.
   */
  readonly writerLabel: string;
  /**
   * COORD-6.1 — emit aris.session_scratchpad.appended on each append
   * so the right-sidebar CoordinatorActivityPanel renders the entry
   * live. Optional so non-adapter callers (tests) can skip the event
   * channel.
   */
  readonly emitCoordinatorEvent?: (event: ArisEvent) => void;
}

/**
 * Build the read + append tools as a 2-element array. Same
 * composition shape as the other DS tool families.
 */
export function createDeepSeekSessionScratchpadTools(ctx: SessionScratchpadToolContext) {
  const readSessionScratchpad = tool({
    name: "read_session_scratchpad",
    description:
      "Read all entries written to the coordinator-session shared " +
      "scratchpad this turn. The session scratchpad is shared across " +
      "you and any workers you spawn (or your peer workers if you " +
      "are a worker). Use this to see what other workers found before " +
      "starting your own work, or — if you're the coordinator — to " +
      "collect findings before synthesis.\n\n" +
      "Distinct from the project scratchpad (`update_scratchpad`) " +
      "which persists across threads/turns; THIS scratchpad starts " +
      "empty every coordinator turn and is automatically scoped to " +
      "the current parent turn. Read it as often as you want — it's " +
      "cheap and the latest writes are always visible.",
    parameters: z.object({}),
    async execute() {
      const entries = await readSessionScratchpadEntries(
        ctx.rollingWindowConfig,
        ctx.cwd,
        ctx.threadId,
        ctx.parentTurnId,
      );
      return renderSessionScratchpad(entries);
    },
  });

  const appendSessionScratchpad = tool({
    name: "append_session_scratchpad",
    description:
      "Append an entry to the coordinator-session shared scratchpad. " +
      "Use this to share a finding, a partial result, or context with " +
      "your peer workers (and the coordinator). Each entry is " +
      "automatically tagged with your identity (parent or your worker " +
      "description). Append-only — there's no clear; the scratchpad " +
      "starts empty every parent turn.\n\n" +
      "Good uses:\n" +
      "- Worker A discovers /src/auth/ uses bcrypt → appends so " +
      "Worker B knows when auditing /src/api/.\n" +
      "- Coordinator publishes the master plan so workers can " +
      "self-orient.\n" +
      "- Worker reports a partial result mid-execution so the parent " +
      "doesn't lose work if the worker hits its budget.\n\n" +
      "Don't use this for routine logging — keep entries focused on " +
      "info other agents in this session would benefit from seeing.",
    parameters: z.object({
      content: z
        .string()
        .describe(
          "The text to append. Be concise but concrete — other agents " +
            "will see this verbatim. Include enough context that someone " +
            "reading without your conversation history can act on it.",
        ),
    }),
    async execute({ content }) {
      if (typeof content !== "string" || content.length === 0) {
        return "append_session_scratchpad requires a non-empty 'content' string.";
      }
      const entry = newSessionScratchpadEntry({ writer: ctx.writerLabel, content });
      await appendSessionScratchpadEntry(
        ctx.rollingWindowConfig,
        ctx.cwd,
        ctx.threadId,
        ctx.parentTurnId,
        entry,
      );
      const all = await readSessionScratchpadEntries(
        ctx.rollingWindowConfig,
        ctx.cwd,
        ctx.threadId,
        ctx.parentTurnId,
      );

      // COORD-6.1 — Emit live event so the sidebar renders this
      // entry without needing to re-read the whole file. Frontend
      // appends to its local list keyed by entryId.
      if (ctx.emitCoordinatorEvent) {
        ctx.emitCoordinatorEvent({
          type: "aris.session_scratchpad.appended",
          threadId: ctx.threadId as never,
          turnId: ctx.parentTurnId as TurnId,
          createdAt: entry.ts as never,
          payload: {
            entryId: entry.id,
            parentTurnId: ctx.parentTurnId as TurnId,
            writer: entry.writer,
            content: entry.content,
            totalEntries: all.length,
          },
        } as ArisEvent);
      }

      return `Appended (writer=${ctx.writerLabel}). Session scratchpad now has ${all.length} entr${all.length === 1 ? "y" : "ies"}.`;
    },
  });

  return [readSessionScratchpad, appendSessionScratchpad];
}
