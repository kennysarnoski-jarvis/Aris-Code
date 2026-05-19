/**
 * DeepSeekAgentTool tests.
 *
 * Coverage:
 *   1. Tool surface — name, parameter schema, single-element array
 *      shape (matches the other DS tool families).
 *   2. Empty-parent guard — returns [] when the parent catalog has
 *      no tools to give workers.
 *   3. (Slice 1) Default worker instructions — confidence-filter
 *      paragraph for REPORTING workers, NOT applied to implementation.
 *   4. (Slice 1) Zod schema accepts/rejects model + effort overrides.
 *
 * What we DON'T test here: actual `run()` of a spawned worker, or the
 * runtime save-and-restore of the reasoning effort holder. Both
 * require either mocking the OpenAI Agents SDK end-to-end or a live
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

import {
  createDeepSeekAgentTool,
  DEFAULT_WORKER_INSTRUCTIONS,
  SPAWN_WORKER_PARAMETERS,
} from "./DeepSeekAgentTool.ts";

const STUB_DEPS_BASE = {
  cloudBaseUrl: "https://example.test",
  cloudToken: "test-bearer",
  defaultModelName: "deepseek-v4-pro",
} as const;

// Minimum valid input for `SPAWN_WORKER_PARAMETERS.safeParse(...)`. The
// schema-level tests use spread + overrides on this so each test reads
// as "minimal input + the field under test."
const MINIMAL_VALID_INPUT = {
  description: "test worker",
  prompt: "do the thing",
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

describe("DEFAULT_WORKER_INSTRUCTIONS (Slice 1)", () => {
  it("includes the >80% confidence filter for REPORT-type workers", () => {
    // The confidence filter is the load-bearing Slice 1 add — without it,
    // every audit worker dumps low-signal findings. Asserting the literal
    // threshold + the REPORT FINDINGS framing so a future edit that loosens
    // either trips this test.
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain(">80% confident");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("REPORT FINDINGS");
  });

  it("explicitly exempts implementation work from the confidence filter", () => {
    // A refactor / edit / scaffold worker must NOT hedge on 70%-confidence
    // code changes. Without this carve-out, the filter would over-trigger
    // and produce sluggish implementation workers.
    expect(DEFAULT_WORKER_INSTRUCTIONS).toMatch(/does NOT apply.+implementation/i);
  });

  it("consolidates similar findings rather than dumping each separately", () => {
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Consolidate similar issues");
  });

  it("preserves the trust-tools-and-finish-quickly guidance from prior versions", () => {
    // The pre-Slice-1 default already had this — Slice 1 only ADDS the
    // confidence paragraph. Regression check that we didn't accidentally
    // drop the original guidance.
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("Trust your tools");
    expect(DEFAULT_WORKER_INSTRUCTIONS).toContain("STOP and emit a final response");
  });
});

describe("spawn_worker Zod schema — Slice 1 model + effort params", () => {
  it("accepts the minimal required input (description + prompt) without any overrides", () => {
    const schema = SPAWN_WORKER_PARAMETERS;
    const result = schema.safeParse(MINIMAL_VALID_INPUT);
    expect(result.success).toBe(true);
  });

  it("accepts 'deepseek-v4-pro' as a valid model slug", () => {
    const schema = SPAWN_WORKER_PARAMETERS;
    const result = schema.safeParse({ ...MINIMAL_VALID_INPUT, model: "deepseek-v4-pro" });
    expect(result.success).toBe(true);
  });

  it("accepts 'deepseek-v4-flash' as a valid model slug", () => {
    const schema = SPAWN_WORKER_PARAMETERS;
    const result = schema.safeParse({ ...MINIMAL_VALID_INPUT, model: "deepseek-v4-flash" });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown model slug like 'deepseek-v5-fake'", () => {
    const schema = SPAWN_WORKER_PARAMETERS;
    const result = schema.safeParse({ ...MINIMAL_VALID_INPUT, model: "deepseek-v5-fake" });
    expect(result.success).toBe(false);
    // Sanity-check the error surfaces clearly enough for the coordinator
    // to retry with a valid slug.
    expect(result.error?.issues.some((i) => i.path.includes("model"))).toBe(true);
  });

  it("accepts null and undefined as omit signals for model (Zod nullable+optional)", () => {
    const schema = SPAWN_WORKER_PARAMETERS;
    expect(schema.safeParse({ ...MINIMAL_VALID_INPUT, model: null }).success).toBe(true);
    expect(schema.safeParse({ ...MINIMAL_VALID_INPUT, model: undefined }).success).toBe(true);
  });

  it("accepts each of the three valid effort values: light / high / max", () => {
    const schema = SPAWN_WORKER_PARAMETERS;
    for (const effort of ["light", "high", "max"] as const) {
      const result = schema.safeParse({ ...MINIMAL_VALID_INPUT, effort });
      expect(result.success).toBe(true);
    }
  });

  it("rejects an unknown effort value like 'medium'", () => {
    // 'medium' is intentionally NOT a valid effort — DS V4 has only the
    // three canonical levels. Skill / template frontmatter authors get
    // loose vocabulary via mapEffortToReasoningEffort coercion; the
    // spawn_worker surface stays strict so the model sees a clear menu.
    const schema = SPAWN_WORKER_PARAMETERS;
    const result = schema.safeParse({ ...MINIMAL_VALID_INPUT, effort: "medium" });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.includes("effort"))).toBe(true);
  });

  it("accepts null and undefined as omit signals for effort", () => {
    const schema = SPAWN_WORKER_PARAMETERS;
    expect(schema.safeParse({ ...MINIMAL_VALID_INPUT, effort: null }).success).toBe(true);
    expect(schema.safeParse({ ...MINIMAL_VALID_INPUT, effort: undefined }).success).toBe(true);
  });

  it("accepts model + effort together (composition check)", () => {
    const schema = SPAWN_WORKER_PARAMETERS;
    const result = schema.safeParse({
      ...MINIMAL_VALID_INPUT,
      model: "deepseek-v4-flash",
      effort: "light",
    });
    expect(result.success).toBe(true);
  });
});

describe("spawn_worker Zod schema — Slice 4 template param", () => {
  it("accepts a string template name", () => {
    const schema = SPAWN_WORKER_PARAMETERS;
    const result = schema.safeParse({ ...MINIMAL_VALID_INPUT, template: "code-reviewer" });
    expect(result.success).toBe(true);
  });

  it("accepts null and undefined as omit signals for template", () => {
    const schema = SPAWN_WORKER_PARAMETERS;
    expect(schema.safeParse({ ...MINIMAL_VALID_INPUT, template: null }).success).toBe(true);
    expect(schema.safeParse({ ...MINIMAL_VALID_INPUT, template: undefined }).success).toBe(true);
  });

  it("rejects a non-string template value", () => {
    // Slice 4: template is a free-form string at the Zod level (the
    // manifest is dynamic per turn). Type-mismatched values like
    // numbers still need to fail at parse time so the SDK doesn't
    // get a weird shape downstream.
    const schema = SPAWN_WORKER_PARAMETERS;
    const result = schema.safeParse({ ...MINIMAL_VALID_INPUT, template: 42 });
    expect(result.success).toBe(false);
    expect(result.error?.issues.some((i) => i.path.includes("template"))).toBe(true);
  });

  it("accepts template + model + effort + max_turns + tools together (full composition)", () => {
    // Slice 4 — explicit args layer ON TOP of a template. The Zod
    // schema doesn't enforce "you must use one OR the other" because
    // the precedence ladder (explicit > template > default) is handled
    // in execute(). Schema just needs to accept the shape.
    const schema = SPAWN_WORKER_PARAMETERS;
    const result = schema.safeParse({
      ...MINIMAL_VALID_INPUT,
      template: "code-reviewer",
      model: "deepseek-v4-flash",
      effort: "max",
      max_turns: 80,
      tools: ["search_knowledge"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty string for template (treated as omitted at execute time)", () => {
    // Schema accepts empty string; execute() treats it as "no template"
    // via the `length > 0` check. Both null and "" mean "ad-hoc spawn".
    const schema = SPAWN_WORKER_PARAMETERS;
    const result = schema.safeParse({ ...MINIMAL_VALID_INPUT, template: "" });
    expect(result.success).toBe(true);
  });
});
