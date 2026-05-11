/**
 * DeepSeekScratchpadTool — DS's `update_scratchpad` tool, backed by the
 * project-scoped jsonl in `ScratchpadMemory`.
 *
 * Slice MEM-1: First DeepSeek-side write tool that targets the new
 * jsonl memory receptacle. Mirrors Aris's `update_scratchpad` tool
 * surface 1:1 (set/append/clear modes, single `content` payload) so
 * the model's prior fluency with the tool carries over without
 * re-prompting changes.
 *
 * Why a separate file instead of folding into `DeepSeekAgentTools`:
 * the same composition pattern as `DeepSeekArchiveTools` — each tool
 * family has its own definition file, and `DeepSeekAgentTools` is the
 * thin composer that concats them. Keeps the tool count per file
 * manageable and lets MEM-2 (todos) + MEM-3 (facts) land in their own
 * files without touching this one.
 *
 * NOT registered for Aris-provider threads — Aris has its own
 * `update_scratchpad` rooted in `aris_memory.db`. Adding this DS tool
 * to Aris would write to two stores in parallel, which is exactly the
 * receptacle confusion this slice exists to eliminate.
 *
 * @module DeepSeekScratchpadTool
 */
import { tool } from "@openai/agents";
import { z } from "zod";

import { appendScratchpadRecord, newScratchpadRecord, readScratchpad } from "./ScratchpadMemory.ts";

export interface ScratchpadToolContext {
  /** Workspace cwd — used to derive `~/.aris/projects/<key>/scratchpad.jsonl`. */
  readonly cwd: string;
}

/**
 * Build the `update_scratchpad` tool. Returns an array (single-element)
 * to match the composition shape used by `createDeepSeekArchiveTools`,
 * so the composer in `DeepSeekAgentTools` can `[...base, ...archive,
 * ...scratchpad]` uniformly.
 */
export function createDeepSeekScratchpadTool(ctx: ScratchpadToolContext) {
  const updateScratchpad = tool({
    name: "update_scratchpad",
    description:
      "Read/write your in-flight scratchpad — a freeform text buffer for " +
      "this PROJECT's working notes. Use it for multi-step tasks where you " +
      "need to track what you've done, what's left, intermediate " +
      "observations, or things to carry forward without burying them in " +
      "the conversation. The scratchpad is auto-loaded into your system " +
      "prompt every turn (you'll see a `<scratchpad>` block when it has " +
      "content), so you don't need to read it explicitly. Persists across " +
      "turns AND across threads in the same project — it's the project's " +
      "shared notepad. Clear it when the multi-step task is fully done.",
    parameters: z.object({
      mode: z
        .enum(["set", "append", "clear"])
        .describe(
          "'set' replaces the entire scratchpad with `content`. 'append' " +
            "adds `content` as a new line at the end. 'clear' empties the " +
            "scratchpad (no `content` needed; pass null or omit).",
        ),
      content: z
        .string()
        .nullable()
        .optional()
        .describe(
          "New content for 'set' or 'append' mode. Required for those two " +
            "modes. Ignored for 'clear' — pass null or omit.",
        ),
    }),
    async execute({ mode, content }) {
      if (mode === "clear") {
        await appendScratchpadRecord(ctx.cwd, newScratchpadRecord({ action: "clear" }));
        return "Scratchpad cleared.";
      }
      // set / append both require a string body. Reject empty/null up
      // front with a clear message rather than persisting an empty
      // record that does nothing visible.
      if (typeof content !== "string" || content.length === 0) {
        return `Mode '${mode}' requires a non-empty 'content' string.`;
      }
      await appendScratchpadRecord(
        ctx.cwd,
        newScratchpadRecord(
          mode === "set" ? { action: "set", content } : { action: "append", content },
        ),
      );
      // Return the resulting state so the model sees the post-write
      // scratchpad without needing a separate read tool. Cheap (one
      // file replay) and avoids the "did my write land?" round-trip.
      const next = await readScratchpad(ctx.cwd);
      return `Scratchpad updated (mode=${mode}). Current contents:\n\n${next}`;
    },
  });

  return [updateScratchpad];
}
