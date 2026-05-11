/**
 * ArisSkillsTool tests — argument-substitution helper + tool factory.
 *
 * The pure expansion path is what most tests exercise. The SDK-tool
 * surface is partially testable: we can assert on the return-type
 * (null vs object) and the description string baked into the tool,
 * but actually invoking `execute` requires the SDK runtime, so the
 * end-to-end dispatch validation lives in the adapter integration
 * tests, not here.
 */
import { describe, expect, it } from "vitest";

import type { Skill } from "./ArisSkillsLoader.ts";
import {
  createUseSkillTool,
  expandSkillBody,
  formatToolRestrictions,
  mapEffortToEnableThinking,
  parseNamedArgs,
  renderSkillForDispatch,
  rewriteSlashCommand,
} from "./ArisSkillsTool.ts";

// ---------------------------------------------------------------------------
// expandSkillBody — pure substitution
// ---------------------------------------------------------------------------

describe("expandSkillBody", () => {
  it("replaces $ARGUMENTS with the supplied string", () => {
    const body = "Debug this: $ARGUMENTS";
    expect(expandSkillBody(body, "the websocket reconnect")).toBe(
      "Debug this: the websocket reconnect",
    );
  });

  it("replaces $ARGUMENTS with empty string when args is undefined", () => {
    const body = "Debug this: $ARGUMENTS";
    expect(expandSkillBody(body, undefined)).toBe("Debug this: ");
  });

  it("replaces $ARGUMENTS with empty string when args is empty string", () => {
    const body = "Debug this: $ARGUMENTS";
    expect(expandSkillBody(body, "")).toBe("Debug this: ");
  });

  it("replaces every occurrence, not just the first", () => {
    const body = "$ARGUMENTS — and again: $ARGUMENTS";
    expect(expandSkillBody(body, "X")).toBe("X — and again: X");
  });

  it("returns body unchanged when no placeholder is present", () => {
    const body = "Run the workflow.";
    expect(expandSkillBody(body, "ignored")).toBe("Run the workflow.");
  });

  it("does not interpret regex metacharacters in the args value", () => {
    const body = "args=[$ARGUMENTS]";
    // If we used a regex replace, `$1` would be interpreted as a
    // backreference. split/join treats it literally.
    expect(expandSkillBody(body, "$1")).toBe("args=[$1]");
  });

  it("substitutes named $ARG_<NAME> placeholders from key=value tokens", () => {
    const body = "Review $ARG_TARGET focusing on $ARG_FOCUS.";
    expect(expandSkillBody(body, "target=auth.ts focus=session-tokens")).toBe(
      "Review auth.ts focusing on session-tokens.",
    );
  });

  it("upper-cases keys for matching, regardless of input casing", () => {
    const body = "x=$ARG_TARGET";
    expect(expandSkillBody(body, "TARGET=ok")).toBe("x=ok");
    expect(expandSkillBody(body, "target=ok")).toBe("x=ok");
    expect(expandSkillBody(body, "Target=ok")).toBe("x=ok");
  });

  it("supports quoted values containing spaces", () => {
    const body = "Focus: $ARG_FOCUS.";
    expect(expandSkillBody(body, 'focus="session tokens and headers"')).toBe(
      "Focus: session tokens and headers.",
    );
  });

  it("leaves unsupplied $ARG_<NAME> placeholders intact (diagnosable failure)", () => {
    const body = "Need $ARG_MISSING here.";
    expect(expandSkillBody(body, "other=ignored")).toBe("Need $ARG_MISSING here.");
  });

  it("expands both $ARG_<NAME> and $ARGUMENTS in the same body", () => {
    const body = "raw='$ARGUMENTS' target=$ARG_TARGET";
    expect(expandSkillBody(body, "target=auth.ts focus=tokens")).toBe(
      "raw='target=auth.ts focus=tokens' target=auth.ts",
    );
  });

  it("does not let $ARGUMENTS substitution re-introduce $ARG_* tokens", () => {
    // Author has $ARG_X in body. Args string contains literal $ARG_X.
    // After named-args pass (which finds nothing, since the args has no
    // key=value), $ARG_X is still in the body. Then the $ARGUMENTS pass
    // injects the literal "$ARG_X" wherever $ARGUMENTS appears.
    // Crucially: the body's original $ARG_X stays as $ARG_X — we don't
    // re-scan after $ARGUMENTS expansion.
    const body = "$ARG_X || $ARGUMENTS";
    expect(expandSkillBody(body, "$ARG_X")).toBe("$ARG_X || $ARG_X");
  });
});

// ---------------------------------------------------------------------------
// parseNamedArgs — pure tokenizer
// ---------------------------------------------------------------------------

describe("parseNamedArgs", () => {
  it("returns an empty record for the empty string", () => {
    expect(parseNamedArgs("")).toEqual({});
  });

  it("parses simple whitespace-separated key=value pairs", () => {
    expect(parseNamedArgs("a=1 b=2")).toEqual({ A: "1", B: "2" });
  });

  it("respects double-quoted values", () => {
    expect(parseNamedArgs('msg="hello world"')).toEqual({ MSG: "hello world" });
  });

  it("respects single-quoted values", () => {
    expect(parseNamedArgs("msg='hello world'")).toEqual({ MSG: "hello world" });
  });

  it("ignores tokens without an equals sign", () => {
    expect(parseNamedArgs("nope a=1 also b=2")).toEqual({ A: "1", B: "2" });
  });

  it("ignores tokens that start with an equals sign", () => {
    expect(parseNamedArgs("=bad good=ok")).toEqual({ GOOD: "ok" });
  });

  it("ignores invalid key shapes", () => {
    // Keys with leading digits, dashes, or special chars are skipped.
    expect(parseNamedArgs("1bad=x kebab-case=y good=z")).toEqual({ GOOD: "z" });
  });

  it("accepts empty values", () => {
    expect(parseNamedArgs("blank= other=ok")).toEqual({ BLANK: "", OTHER: "ok" });
  });

  it("handles equals signs inside values (only first '=' splits)", () => {
    expect(parseNamedArgs("expr=a=b=c")).toEqual({ EXPR: "a=b=c" });
  });

  it("uppercases keys", () => {
    expect(parseNamedArgs("FocusArea=x")).toEqual({ FOCUSAREA: "x" });
  });
});

// ---------------------------------------------------------------------------
// formatToolRestrictions + renderSkillForDispatch — 32d soft enforcement
// ---------------------------------------------------------------------------

describe("formatToolRestrictions", () => {
  it("renders a markdown-style restriction notice listing each allowed tool", () => {
    const text = formatToolRestrictions(["read_file", "edit_file"]);
    expect(text).toContain("## Tool restrictions for this skill");
    expect(text).toContain("- read_file");
    expect(text).toContain("- edit_file");
    expect(text).toContain("Do not call any other tools");
  });
});

describe("renderSkillForDispatch", () => {
  it("returns the expanded body unchanged when allowed-tools is undefined", () => {
    const body = "Run the workflow with $ARGUMENTS.";
    expect(renderSkillForDispatch(body, "X", undefined)).toBe("Run the workflow with X.");
  });

  it("returns the expanded body unchanged when allowed-tools is an empty array", () => {
    const body = "Run the workflow.";
    expect(renderSkillForDispatch(body, undefined, [])).toBe("Run the workflow.");
  });

  it("prepends the restriction notice when allowed-tools is non-empty", () => {
    const body = "Edit the file.";
    const rendered = renderSkillForDispatch(body, undefined, ["read_file", "edit_file"]);
    // Restriction notice precedes the body, separated by a blank line.
    expect(rendered.startsWith("## Tool restrictions for this skill")).toBe(true);
    expect(rendered.endsWith("Edit the file.")).toBe(true);
  });

  it("composes with $ARGUMENTS / $ARG_<NAME> substitution", () => {
    const body = "Edit $ARG_TARGET. Original: $ARGUMENTS";
    const rendered = renderSkillForDispatch(body, "target=auth.ts", ["read_file", "edit_file"]);
    expect(rendered).toContain("Edit auth.ts.");
    expect(rendered).toContain("Original: target=auth.ts");
    expect(rendered).toContain("- read_file");
  });
});

// ---------------------------------------------------------------------------
// 32e — fork-mode dispatch routing
// ---------------------------------------------------------------------------
//
// We can't actually run a sub-agent in unit tests (that would need the
// full SDK runtime + an aris_server), but we CAN verify that the
// `use_skill` execute callback routes to the injected `forkExecutor`
// when a skill declares `context: fork`, and that it falls back
// gracefully when no executor is configured.

describe("createUseSkillTool — fork-mode dispatch", () => {
  // The user's `execute({ name, args })` callback is captured INSIDE
  // the SDK wrapper — the outer surface that the runtime drives is
  // `.invoke(runContext, jsonInput)` per `@openai/agents-core@0.10.x`'s
  // `tool.d.ts`. The SDK shape isn't a stable public type for testing
  // so we cast to the minimal subset we need.
  type Invokable = {
    invoke: (runContext: unknown, input: string) => Promise<unknown>;
  };
  const invokeUseSkill = async (
    tool: ReturnType<typeof createUseSkillTool>,
    args: { name: string; args: string | null },
  ): Promise<unknown> => (tool as unknown as Invokable).invoke({}, JSON.stringify(args));

  it("calls the injected forkExecutor when context is 'fork'", async () => {
    const calls: Array<{ name: string; renderedBody: string; args: string | undefined }> = [];
    const tool = createUseSkillTool({
      skills: [
        mkSkill({
          name: "review",
          body: "Review $ARG_TARGET",
          frontmatter: {
            raw: Object.freeze({}),
            context: "fork",
          },
        }),
      ],
      forkExecutor: async ({ skill, renderedBody, args }) => {
        calls.push({ name: skill.name, renderedBody, args });
        return "[sub-agent result]";
      },
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const result = await invokeUseSkill(tool, {
      name: "review",
      args: "target=auth.ts",
    });
    expect(result).toBe("[sub-agent result]");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.name).toBe("review");
    expect(calls[0]?.args).toBe("target=auth.ts");
    expect(calls[0]?.renderedBody).toContain("Review auth.ts");
  });

  it("does NOT call forkExecutor when context is 'inline' or absent", async () => {
    let called = false;
    const tool = createUseSkillTool({
      skills: [
        mkSkill({
          name: "debug",
          body: "Debug body.",
          frontmatter: {
            raw: Object.freeze({}),
            context: "inline",
          },
        }),
      ],
      forkExecutor: async () => {
        called = true;
        return "should not be called";
      },
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const result = await invokeUseSkill(tool, {
      name: "debug",
      args: null,
    });
    expect(called).toBe(false);
    expect(result).toBe("Debug body.");
  });

  it("falls back to inline rendering with a warning when fork is requested but no executor is set", async () => {
    const tool = createUseSkillTool({
      skills: [
        mkSkill({
          name: "review",
          body: "Body",
          frontmatter: {
            raw: Object.freeze({}),
            context: "fork",
          },
        }),
      ],
      // forkExecutor intentionally omitted
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const result = (await invokeUseSkill(tool, {
      name: "review",
      args: null,
    })) as string;
    expect(result).toContain("[fork mode unavailable for skill 'review'");
    expect(result).toContain("Body");
  });

  it("converts thrown executor errors into a tool-result string instead of failing the call", async () => {
    const tool = createUseSkillTool({
      skills: [
        mkSkill({
          name: "review",
          body: "Body",
          frontmatter: {
            raw: Object.freeze({}),
            context: "fork",
          },
        }),
      ],
      forkExecutor: async () => {
        throw new Error("vLLM exploded");
      },
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const result = (await invokeUseSkill(tool, {
      name: "review",
      args: null,
    })) as string;
    expect(result).toContain("Error: skill 'review' fork execution failed");
    expect(result).toContain("vLLM exploded");
  });
});

// ---------------------------------------------------------------------------
// 32f — mapEffortToEnableThinking
// ---------------------------------------------------------------------------

describe("mapEffortToEnableThinking", () => {
  it.each(["high", "medium", "thinking", "on", "yes", "true", "TRUE", "  high  "])(
    "maps '%s' → true",
    (input) => {
      expect(mapEffortToEnableThinking(input)).toBe(true);
    },
  );

  it.each(["low", "minimal", "off", "no", "false", "FALSE", "  low  "])(
    "maps '%s' → false",
    (input) => {
      expect(mapEffortToEnableThinking(input)).toBe(false);
    },
  );

  it("returns undefined for unknown literals (no override)", () => {
    expect(mapEffortToEnableThinking("turbo")).toBeUndefined();
    expect(mapEffortToEnableThinking("ultra")).toBeUndefined();
  });

  it("returns undefined for empty/missing values", () => {
    expect(mapEffortToEnableThinking("")).toBeUndefined();
    expect(mapEffortToEnableThinking(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 32h — rewriteSlashCommand
// ---------------------------------------------------------------------------

describe("rewriteSlashCommand", () => {
  const skills = [
    mkSkill({
      name: "debug",
      body: "Walk through the issue: $ARGUMENTS",
      frontmatter: { raw: Object.freeze({}) },
    }),
    mkSkill({
      name: "review",
      body: "Review $ARG_TARGET focusing on $ARG_FOCUS.",
      frontmatter: {
        raw: Object.freeze({}),
        arguments: ["target", "focus"],
      },
    }),
    mkSkill({
      name: "restricted",
      body: "Do the thing.",
      frontmatter: {
        raw: Object.freeze({}),
        allowedTools: ["read_file"],
      },
    }),
  ];

  it("returns null when the message doesn't start with a slash", async () => {
    const result = await rewriteSlashCommand({ text: "regular message", skills });
    expect(result).toBeNull();
  });

  it("returns null when the slash command's name doesn't match a loaded skill", async () => {
    const result = await rewriteSlashCommand({ text: "/nope here we go", skills });
    expect(result).toBeNull();
  });

  it("does not hijack literal paths starting with a slash", async () => {
    // `/path` is not a loaded skill, so it passes through unchanged
    // (the adapter ends up sending the original text to the model).
    const result = await rewriteSlashCommand({ text: "/path/to/file.ts", skills });
    expect(result).toBeNull();
  });

  it("rewrites a bare /skillname (no args) to the rendered body with empty $ARGUMENTS", async () => {
    const result = await rewriteSlashCommand({ text: "/debug", skills });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.skillName).toBe("debug");
    expect(result.args).toBe("");
    // Framing prefix tells the model to execute, then the rendered body follows.
    expect(result.text).toContain("The user invoked the `/debug` skill");
    expect(result.text).toContain("Execute the workflow below now");
    expect(result.text).toContain("Walk through the issue: ");
  });

  it("rewrites /skillname args... preserving args in $ARGUMENTS", async () => {
    const result = await rewriteSlashCommand({
      text: "/debug stuck on the websocket reconnect",
      skills,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.skillName).toBe("debug");
    expect(result.args).toBe("stuck on the websocket reconnect");
    expect(result.text).toContain("with arguments: stuck on the websocket reconnect");
    expect(result.text).toContain("Walk through the issue: stuck on the websocket reconnect");
  });

  it("supports key=value args populating $ARG_<NAME>", async () => {
    const result = await rewriteSlashCommand({
      text: "/review target=auth.ts focus=session-tokens",
      skills,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.skillName).toBe("review");
    expect(result.text).toContain("Review auth.ts focusing on session-tokens.");
  });

  it("prepends the tool-restriction prefix when the skill declares allowed-tools", async () => {
    const result = await rewriteSlashCommand({ text: "/restricted", skills });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.text).toContain("## Tool restrictions for this skill");
    expect(result.text).toContain("- read_file");
    expect(result.text).toContain("Do the thing.");
  });

  it("supports multi-line args (everything after the first whitespace counts)", async () => {
    const result = await rewriteSlashCommand({
      text: "/debug line one\nline two\nline three",
      skills,
    });
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.args).toBe("line one\nline two\nline three");
  });
});

// ---------------------------------------------------------------------------
// createUseSkillTool — registration shape
// ---------------------------------------------------------------------------

const mkSkill = (overrides: Partial<Skill> & { name: string; body: string }): Skill => ({
  source: "project",
  filePath: `/tmp/${overrides.name}/SKILL.md`,
  directory: `/tmp/${overrides.name}`,
  frontmatter: { raw: Object.freeze({}) },
  ...overrides,
});

describe("createUseSkillTool", () => {
  it("returns null when the skills array is empty", () => {
    expect(createUseSkillTool({ skills: [] })).toBeNull();
  });

  it("returns a tool when at least one skill is present", () => {
    const tool = createUseSkillTool({
      skills: [mkSkill({ name: "debug", body: "debug body" })],
    });
    expect(tool).not.toBeNull();
  });

  it("bakes the skills manifest into the tool description", () => {
    const tool = createUseSkillTool({
      skills: [
        mkSkill({
          name: "debug",
          body: "...",
          frontmatter: {
            raw: Object.freeze({}),
            whenToUse: "When the user is stuck",
          },
        }),
        mkSkill({
          name: "test",
          body: "...",
          frontmatter: {
            raw: Object.freeze({}),
            whenToUse: "When the user asks for tests",
          },
        }),
      ],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const description = (tool as { description: string }).description;
    expect(description).toContain("- debug — When the user is stuck");
    expect(description).toContain("- test — When the user asks for tests");
  });

  it("falls back to description when when-to-use is absent", () => {
    const tool = createUseSkillTool({
      skills: [
        mkSkill({
          name: "explain",
          body: "...",
          frontmatter: {
            raw: Object.freeze({}),
            description: "Teach a concept",
          },
        }),
      ],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const description = (tool as { description: string }).description;
    expect(description).toContain("- explain — Teach a concept");
  });

  it("includes argument hints when any skill declares one", () => {
    const tool = createUseSkillTool({
      skills: [
        mkSkill({
          name: "debug",
          body: "...",
          frontmatter: {
            raw: Object.freeze({}),
            argumentHint: "<what's broken>",
          },
        }),
      ],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const description = (tool as { description: string }).description;
    expect(description).toContain("Argument hints:");
    expect(description).toContain("- debug: <what's broken>");
  });

  it("omits the argument-hints section when no skills declare hints", () => {
    const tool = createUseSkillTool({
      skills: [mkSkill({ name: "debug", body: "..." })],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const description = (tool as { description: string }).description;
    expect(description).not.toContain("Argument hints:");
  });

  it("surfaces the named-arguments section when a skill declares `arguments`", () => {
    const tool = createUseSkillTool({
      skills: [
        mkSkill({
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

  it("omits the named-arguments section when no skill declares any", () => {
    const tool = createUseSkillTool({
      skills: [mkSkill({ name: "debug", body: "..." })],
    });
    expect(tool).not.toBeNull();
    if (!tool) return;
    const description = (tool as { description: string }).description;
    expect(description).not.toContain("Named arguments");
  });
});
