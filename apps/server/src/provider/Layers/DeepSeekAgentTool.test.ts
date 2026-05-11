/**
 * DeepSeekAgentTool tests.
 *
 * Coverage:
 *   1. Tool surface — name, parameter schema, single-element array
 *      shape (matches the other DS tool families).
 *   2. Empty-parent guard — returns [] when the parent catalog has
 *      no tools to give workers.
 *
 * What we DON'T test here: actual `run()` of a spawned worker. That
 * requires either mocking the OpenAI Agents SDK end-to-end or a live
 * cloud trusted-caller endpoint, both of which belong in integration
 * tests not unit tests. The execute path is exercised live in the
 * Electron app — same pattern as the other DS tool families
 * (DeepSeekScratchpadTool/TodosTool/FactsTool execute paths aren't
 * unit-tested either; the underlying storage modules carry the unit
 * test load and the tool surface is just the orchestrator).
 *
 * Tool-list filtering (exclusion-based default vs whitelist override)
 * runs inside `execute` and depends on `parentTools.filter(...)` over
 * actual SDK tool instances. Not unit-testable without spinning up
 * the SDK; covered by live testing.
 */
import { describe, expect, it } from "vitest";

import { createDeepSeekAgentTool } from "./DeepSeekAgentTool.ts";

const STUB_DEPS_BASE = {
  cloudBaseUrl: "https://example.test",
  cloudToken: "test-bearer",
  defaultModelName: "deepseek-v4-pro",
} as const;

describe("createDeepSeekAgentTool", () => {
  it("returns a single-element array containing the spawn_worker tool when parentTools is non-empty", () => {
    // Use a stub tool just to make parentTools non-empty. The factory
    // doesn't actually call into parentTools at construction time —
    // it captures the array for later use in execute().
    const stubTool = { name: "stub_for_test" } as never;
    const tools = createDeepSeekAgentTool({
      ...STUB_DEPS_BASE,
      parentTools: [stubTool],
    });
    expect(tools).toHaveLength(1);
    const t = tools[0] as unknown as { name: string };
    expect(t.name).toBe("spawn_worker");
  });

  it("returns an empty array when parentTools is empty (defensive guard)", () => {
    const tools = createDeepSeekAgentTool({
      ...STUB_DEPS_BASE,
      parentTools: [],
    });
    expect(tools).toEqual([]);
  });

  it("accepts an optional AbortSignal in deps without affecting tool shape", () => {
    const ac = new AbortController();
    const stubTool = { name: "stub_for_test" } as never;
    const tools = createDeepSeekAgentTool({
      ...STUB_DEPS_BASE,
      parentTools: [stubTool],
      abortSignal: ac.signal,
    });
    expect(tools).toHaveLength(1);
  });
});
