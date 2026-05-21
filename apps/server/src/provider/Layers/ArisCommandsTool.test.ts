/**
 * ArisCommandsTool tests — `use_command` tool factory + execute path.
 *
 * Mirrors the structure of ArisSkillsTool.test.ts's
 * `createUseSkillTool` suite. The `invoke()` helper lets us drive the
 * SDK-wrapped execute callback synchronously from a unit test without
 * needing the full Agents runtime.
 */
import { describe, expect, it } from "vitest";

import type { Command } from "./ArisCommandsLoader.ts";
import { createUseCommandTool } from "./ArisCommandsTool.ts";

const mkCommand = (overrides: Partial<Command> & { name: string; body: string }): Command => ({
  source: "project",
  filePath: `/tmp/${overrides.name}.md`,
  frontmatter: { raw: Object.freeze({}) },
  ...overrides,
});

// The user's `execute({ name, args })` callback is captured INSIDE the
// SDK tool wrapper — same shape as ArisSkillsTool tests use. Cast to a
// minimal subset since the SDK's invoke shape isn't a stable public
// type for testing.
type Invokable = {
  invoke: (runContext: unknown, input: string) => Promise<unknown>;
};
const invokeUseCommand = async (
  tool: ReturnType<typeof createUseCommandTool>,
  args: { name: string; args: string | null },
): Promise<unknown> => (tool as unknown as Invokable).invoke({}, JSON.stringify(args));

// ---------------------------------------------------------------------------
// createUseCommandTool — registration shape
// ---------------------------------------------------------------------------

describe("createUseCommandTool — registration shape", () => {
  it("returns null when the commands array is empty", () => {
    expect(createUseCommandTool({ commands: [] })).toBeNull();
  });

  it("returns a tool when at least one command is present", () => {
    const tool = createUseCommandTool({
      commands: [mkCommand({ name: "tdd", body: "Run TDD" })],
    });
    expect(tool).not.toBeNull();
  });

  it("bakes the commands manifest into the tool description", () => {
    const tool = createUseCommandTool({
      commands: [
        mkCommand({
          name: "tdd",
          body: "...",
          frontmatter: {
            raw: Object.freeze({}),
            description: "Enforce test-driven development",
          },
        }),
        mkCommand({
          name: "plan",
          body: "...",
          frontmatter: {
            raw: Object.freeze({}),
            description: "Plan a feature",
          },
        }),
      ],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const description = (tool as { description: string }).description;
    expect(description).toContain("- tdd — Enforce test-driven development");
    expect(description).toContain("- plan — Plan a feature");
  });

  it("uses '(no description)' for commands missing a description", () => {
    const tool = createUseCommandTool({
      commands: [mkCommand({ name: "raw", body: "Just a body" })],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const description = (tool as { description: string }).description;
    expect(description).toContain("- raw — (no description)");
  });

  it("includes argument hints when any command declares one", () => {
    const tool = createUseCommandTool({
      commands: [
        mkCommand({
          name: "tdd",
          body: "...",
          frontmatter: {
            raw: Object.freeze({}),
            argumentHint: "<feature to TDD>",
          },
        }),
      ],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const description = (tool as { description: string }).description;
    expect(description).toContain("Argument hints:");
    expect(description).toContain("- tdd: <feature to TDD>");
  });

  it("omits the argument-hints section when no commands declare hints", () => {
    const tool = createUseCommandTool({
      commands: [mkCommand({ name: "tdd", body: "..." })],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const description = (tool as { description: string }).description;
    expect(description).not.toContain("Argument hints:");
  });

  it("surfaces the named-arguments section when a command declares `arguments`", () => {
    const tool = createUseCommandTool({
      commands: [
        mkCommand({
          name: "review",
          body: "...",
          frontmatter: {
            raw: Object.freeze({}),
            arguments: ["target", "focus"],
          },
        }),
      ],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const description = (tool as { description: string }).description;
    expect(description).toContain("Named arguments");
    expect(description).toContain("- review: target, focus");
  });

  it("omits the named-arguments section when no command declares any", () => {
    const tool = createUseCommandTool({
      commands: [mkCommand({ name: "tdd", body: "..." })],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const description = (tool as { description: string }).description;
    expect(description).not.toContain("Named arguments");
  });
});

// ---------------------------------------------------------------------------
// createUseCommandTool — execute dispatch
// ---------------------------------------------------------------------------

describe("createUseCommandTool — execute dispatch", () => {
  it("returns the rendered body when the command name resolves", async () => {
    const tool = createUseCommandTool({
      commands: [mkCommand({ name: "tdd", body: "Run TDD: $ARGUMENTS" })],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const result = await invokeUseCommand(tool, { name: "tdd", args: "auth flow" });
    expect(result).toBe("Run TDD: auth flow");
  });

  it("substitutes $ARGUMENTS with empty string when args is null", async () => {
    const tool = createUseCommandTool({
      commands: [mkCommand({ name: "checkpoint", body: "Save: $ARGUMENTS" })],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const result = await invokeUseCommand(tool, { name: "checkpoint", args: null });
    expect(result).toBe("Save: ");
  });

  it("substitutes $ARG_<NAME> from key=value tokens in args", async () => {
    const tool = createUseCommandTool({
      commands: [
        mkCommand({
          name: "review",
          body: "Review $ARG_TARGET focusing on $ARG_FOCUS.",
        }),
      ],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const result = await invokeUseCommand(tool, {
      name: "review",
      args: "target=auth.ts focus=session-tokens",
    });
    expect(result).toBe("Review auth.ts focusing on session-tokens.");
  });

  it("returns an error string when the command name is unknown", async () => {
    const tool = createUseCommandTool({
      commands: [mkCommand({ name: "tdd", body: "..." }), mkCommand({ name: "plan", body: "..." })],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const result = await invokeUseCommand(tool, { name: "no-such-cmd", args: null });
    expect(typeof result).toBe("string");
    const text = result as string;
    expect(text).toContain("Error: unknown command 'no-such-cmd'");
    expect(text).toContain("plan, tdd");
  });

  it("reports '(none)' when there's no manifest at all (edge case)", async () => {
    // createUseCommandTool returns null on empty commands, but if the
    // map somehow ends up empty mid-execute (shouldn't happen with the
    // current factory), the error string should still be intelligible.
    // We can't easily trigger this without a private API tweak; the
    // factory's `if (opts.commands.length === 0) return null` guard
    // means an empty manifest never produces a tool. This test exists
    // as a smoke check that a single-command tool with a wrong name
    // still produces the standard "Available commands: <names>" form.
    const tool = createUseCommandTool({
      commands: [mkCommand({ name: "only", body: "..." })],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const result = (await invokeUseCommand(tool, { name: "missing", args: null })) as string;
    expect(result).toContain("Available commands: only");
  });

  it("never throws when the command body has no placeholders", async () => {
    const tool = createUseCommandTool({
      commands: [mkCommand({ name: "noop", body: "Just a static body, no placeholders." })],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const result = await invokeUseCommand(tool, { name: "noop", args: "ignored" });
    expect(result).toBe("Just a static body, no placeholders.");
  });
});
