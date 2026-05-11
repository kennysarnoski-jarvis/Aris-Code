/**
 * DeepSeekFactsTool — DS's `upsert_memory_node` + `delete_memory_node`
 * tools, backed by the user-global jsonl in `FactsMemory`.
 *
 * Slice MEM-3: Cross-project memory layer. Mirrors Aris's tool names
 * 1:1 (`upsert_memory_node` and `delete_memory_node`) so the model's
 * prior fluency carries over without re-prompting. The receptacle
 * changed (sqlite + graph → jsonl + replay) and the type set is
 * narrower (user + feedback only — project + reference dropped per
 * Kenny, since scratchpad covers per-project notes).
 *
 * Scope is USER-GLOBAL — facts written here apply across every
 * project the user opens in Aris Code. Distinct from MEM-1
 * (scratchpad) and MEM-2 (todos), which are project-scoped.
 *
 * NOT registered for Aris-provider threads — Aris has its own
 * `upsert_memory_node` rooted in `aris_memory.db`. Adding this DS
 * tool to Aris would write to two stores in parallel.
 *
 * @module DeepSeekFactsTool
 */
import { tool } from "@openai/agents";
import { z } from "zod";

import {
  appendFactsRecord,
  newFactsRecord,
  readFacts,
  renderFacts,
  withFactsWriteLock,
} from "./FactsMemory.ts";

/**
 * Build the `upsert_memory_node` and `delete_memory_node` tools.
 * Returns a 2-element array to match the composition shape used by
 * the other DS tool families.
 *
 * Note: `factType` on disk corresponds to the tool param `type`. The
 * tool surface uses `type` to match Aris's existing tool API; the
 * persisted record uses `factType` to avoid the overloaded `type`
 * keyword in code. The mapping is just rename-on-write.
 */
export function createDeepSeekFactsTools() {
  const upsertMemoryNode = tool({
    name: "upsert_memory_node",
    description:
      "Save or update a USER-GLOBAL fact about the user or about how " +
      "they want you to behave. Each fact is keyed on `(type, label)` — " +
      "writing an existing pair UPDATES the row.\n\n" +
      "Type MUST be one of:\n" +
      "  - `user` — identity facts about the user themselves (name, " +
      "role, people in their life, preferences, schedule).\n" +
      "  - `feedback` — rules the user has given you about how to " +
      "behave (response style, words to avoid, code conventions).\n\n" +
      "Both types persist across EVERY project the user opens — that's " +
      "what distinguishes facts from the scratchpad (per-project notes) " +
      "and todos (per-project tasks). Use facts for things the user " +
      "would want you to remember even if they switch projects.\n\n" +
      "Label is a short stable id, lowercase with hyphens or " +
      "underscores (e.g. 'name', 'no-patches', 'workday-end-time'). " +
      "Description is a one-line hook (~150 chars) used in future " +
      "conversations to decide whether the fact is relevant. Content " +
      "is the full body — 1–3 sentences. Keep it concrete.\n\n" +
      "The current facts are auto-loaded into your system prompt every " +
      "turn (you'll see a `<facts>` block when any exist), so you don't " +
      "need to read them explicitly. After this call, the block " +
      "refreshes from the file.",
    parameters: z.object({
      type: z
        .enum(["user", "feedback"])
        .describe(
          "One of: `user` (identity facts) or `feedback` (behavior rules). " +
            "Both are user-global — they apply across every project.",
        ),
      label: z
        .string()
        .describe(
          "Short stable id for this fact, lowercase with hyphens or " +
            "underscores (e.g. 'name', 'no-patches'). Same `(type, label)` " +
            "in a future call UPDATES this fact.",
        ),
      description: z
        .string()
        .describe(
          "One-line hook (~150 chars) describing what this fact is. " +
            "Used in future conversations to decide if the fact is " +
            "relevant. Be specific — 'Kenny prefers em-dashes over " +
            "hyphens in prose' is better than 'punctuation preference'.",
        ),
      content: z
        .string()
        .describe(
          "Full body of the fact — 1–3 sentences. Concrete details. " +
            "For feedback rules, lead with the rule itself, then any " +
            "context about why or when it applies.",
        ),
    }),
    async execute({ type, label, description, content }) {
      return await withFactsWriteLock(async () => {
        await appendFactsRecord(
          newFactsRecord({
            action: "upsert",
            factType: type,
            label,
            description,
            content,
          }),
        );
        const next = await readFacts();
        const block = renderFacts(next);
        return `Fact saved (type=${type}, label=${label}).\n\nCurrent facts:\n\n${block || "(none)"}`;
      });
    },
  });

  const deleteMemoryNode = tool({
    name: "delete_memory_node",
    description:
      "Delete a previously-saved fact. Use when the user explicitly " +
      "asks to forget something, OR when you discover a stored fact is " +
      "wrong and a fresh upsert under a different label would leave " +
      "stale data behind.\n\n" +
      "Identity is `(type, label)` — same tuple used by " +
      "`upsert_memory_node`. Deleting a non-existent fact is a no-op " +
      "with a clear message; we don't fail loudly. After this call, " +
      "the `<facts>` block refreshes from the file.",
    parameters: z.object({
      type: z
        .enum(["user", "feedback"])
        .describe("Exact type of the fact to delete (one of `user`, `feedback`)."),
      label: z
        .string()
        .describe(
          "Exact label of the fact to delete (e.g. 'name'). Must match " +
            "what was stored — find it in the `<facts>` block above.",
        ),
    }),
    async execute({ type, label }) {
      return await withFactsWriteLock(async () => {
        // Probe before deleting so the model gets a useful error
        // rather than a silent no-op when the label is wrong.
        const before = await readFacts();
        if (!before.some((f) => f.factType === type && f.label === label)) {
          return `No fact with (type=${type}, label=${label}) found. Check the <facts> block in the system prompt for exact labels.`;
        }
        await appendFactsRecord(newFactsRecord({ action: "delete", factType: type, label }));
        const next = await readFacts();
        const block = renderFacts(next);
        return `Fact deleted (type=${type}, label=${label}).\n\nCurrent facts:\n\n${block || "(none)"}`;
      });
    },
  });

  return [upsertMemoryNode, deleteMemoryNode];
}
